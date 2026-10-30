import { loadEnvFile } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { loadDatabaseConfig } from './config.js';

/**
 * Migrazioni versionate con ledger, transazione unica e advisory lock.
 *
 * Prima di questo modulo `migrateUp` rileggeva **tutti** i file a ogni
 * bootstrap: DDL ridondante e lock esclusivi inutili su tabelle attive,
 * fallimento garantito alla prima migrazione non idempotente (un `ALTER TABLE`
 * o un `CREATE INDEX` non condizionale basta), e due repliche avviate insieme
 * che si contendevano lo schema. `migrateDown` invece rispondeva
 * `success: true` senza eseguire nulla: un rollback fantasma, con il database
 * rimasto avanti rispetto a ciò che la pipeline credeva.
 *
 * Ora:
 * - `schema_migrations` (ledger) registra cosa è stato applicato: ogni file
 *   gira **una volta sola**, e la riga entra nel ledger nella stessa
 *   transazione della sua DDL (o entrambe o nessuna);
 * - l'intero ciclo di `up`/`down` vive in una transazione che inizia con
 *   `pg_try_advisory_xact_lock`: processi e container concorrenti si
 *   serializzano, e chi arriva secondo trova il ledger già aggiornato;
 * - `migrateDown` esegue davvero la sezione DOWN e cancella la riga dal ledger.
 *   Se la sezione manca, è vuota o il file non esiste più, solleva un
 *   `MigrationError`: mai un `success: true` senza modifiche.
 */

/** Nome della tabella ledger: una riga per migrazione applicata. */
export const MIGRATIONS_LEDGER = 'schema_migrations';

/**
 * Chiave dell'advisory lock (`hashtext`): lo stesso valore in ogni processo,
 * quindi due container che partono insieme non applicano DDL in parallelo.
 */
export const MIGRATIONS_LOCK_KEY = 'wallos_migrations';

const DEFAULT_MIGRATION_DIR = 'server/migrations';
/** Attesa massima per l'advisory lock prima di fallire il bootstrap. */
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** Intervallo fra due tentativi di lock: sotto il secondo, sopra il polling stretto. */
const LOCK_RETRY_MS = 200;

/**
 * Attesa massima per un lock su tabella dentro la transazione di migrazione.
 *
 * Un `ALTER TABLE` che deve aspettare un lettore o un altro DDL in corso non
 * deve bloccare il bootstrap a tempo indefinito: dopo questo limite PostgreSQL
 * annulla lo statement con `55P03` e la transazione va in ROLLBACK. Cinque
 * secondi bastano su una LAN con un solo pannello; un DDL legittimo che deve
 * aspettare oltre significa che c'è una sessione da chiudere, non da attendere.
 */
export const DEFAULT_DDL_LOCK_TIMEOUT_MS = 5_000;

/**
 * Durata massima di una singola istruzione dentro la transazione di migrazione.
 * Oltre, `57014` (`canceling statement due to statement timeout`): la
 * migrazione non entra nel ledger e l'errore risale subito al bootstrap.
 */
export const DEFAULT_DDL_STATEMENT_TIMEOUT_MS = 30_000;

/** Policy DDL della transazione, in millisecondi. */
export interface DdlTimeoutOptions {
  /** Attesa massima per un lock su tabella (default 5 s). */
  ddlLockTimeoutMs?: number;
  /** Durata massima di una singola istruzione DDL (default 30 s). */
  ddlStatementTimeoutMs?: number;
}

/** Valori effettivamente applicati con `SET LOCAL`. */
export interface DdlTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export type MigrationErrorCode =
  | 'LOCK_TIMEOUT'
  | 'SQL_ERROR'
  | 'EMPTY_UP_SECTION'
  | 'NO_APPLIED_MIGRATIONS'
  | 'MISSING_MIGRATION_FILE'
  | 'NO_DOWN_SECTION';

/** Errore di migrazione con un codice stabile per log, CLI e test. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
    this.code = code;
  }
}

/**
 * Una singola sessione verso PostgreSQL. Soddisfatta dall'adattatore su
 * `pg.PoolClient` qui sotto e, nei test, da PGlite e da un finto cluster in
 * memoria: il runner non conosce il driver.
 */
export interface MigrationConnection {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  /** Statement multipli, anche con blocchi `$$ … $$` (simple query protocol). */
  exec(sql: string): Promise<void>;
  /** Riporta la sessione al pool. Assente sulle connessioni possedute da altri. */
  release?(): void;
}

export interface MigrateOptions extends DdlTimeoutOptions {
  /** Connessione già acquisita: se la passi, il chiamante la possiede e la rilascia. */
  connection?: MigrationConnection;
  /** Directory delle migrazioni (default: `MIGRATION_DIR` o `server/migrations`). */
  dir?: string;
  /** Attesa massima per l'advisory lock prima di fallire (default 30 s). */
  lockTimeoutMs?: number;
  /** Destinazione dei log (default `console.log`). */
  log?: (message: string) => void;
}

export interface MigrateUpResult {
  /** File applicati in questa esecuzione, in ordine di applicazione. */
  applied: string[];
}

export interface MigrateDownResult {
  /** File annullato: la versione rimossa dal ledger. */
  rolledBack: string;
}

/**
 * Directory delle migrazioni. Letta a ogni chiamata e non a import-time, così
 * `MIGRATION_DIR` definita nel `.env` vale anche per `npm run migrate:up`.
 */
function resolveMigrationDir(dir?: string): string {
  const migrationDir =
    dir || process.env.MIGRATION_DIR || path.resolve(process.cwd(), DEFAULT_MIGRATION_DIR);
  fs.mkdirSync(migrationDir, { recursive: true });
  return migrationDir;
}

/** File `.sql` della cartella, in ordine di applicazione (nome crescente). */
export function listMigrationFiles(dir?: string): string[] {
  const migrationDir = resolveMigrationDir(dir);
  return fs
    .readdirSync(migrationDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/**
 * Marcatori di sezione, nella forma scritta da `migrate:create`:
 *
 *   -- ----------------------------
 *   -- 006_kiosk_displays.sql - UP
 *   -- ----------------------------
 *
 * Il `--` iniziale è obbligatorio: senza, un `END` di un blocco `DO $$ BEGIN …
 * END $$;` verrebbe scambiato per un marcatore di sezione.
 */
const MARKER_PATTERN_SOURCE = String.raw`^--[^\S\n]*(\S+)[^\S\n]*-[^\S\n]*(UP|DOWN|END)[^\S\n]*$`;

interface MarkerRange {
  start: number;
  end: number;
}

function findMarker(sql: string, label: 'UP' | 'DOWN' | 'END', from = 0): MarkerRange | null {
  const pattern = new RegExp(MARKER_PATTERN_SOURCE, 'gim');
  pattern.lastIndex = from;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    if (match[2]?.toUpperCase() === label) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

export interface MigrationSections {
  /** Sezione UP: tutto ciò che precede il marcatore DOWN. */
  up: string;
  /** Sezione DOWN, o `null` se il file non ne definisce una. */
  down: string | null;
}

/**
 * Separa le due sezioni di un file di migrazione. Eseguire l'intero file
 * applicherebbe anche il rollback, cancellando a ogni avvio ciò che la sezione
 * UP ha appena creato: il taglio sul marcatore è ciò che rende sicuri sia l'up
 * sia il down. Un file senza marcatore è tutto UP, senza DOWN.
 */
export function parseMigration(sql: string): MigrationSections {
  const down = findMarker(sql, 'DOWN');
  if (!down) return { up: sql, down: null };

  // Il marcatore `END` (fine file generata dal template) chiude la sezione
  // DOWN: dopo c'è solo documentazione.
  const end = findMarker(sql, 'END', down.end);
  return {
    up: sql.slice(0, down.start),
    down: sql.slice(down.end, end ? end.start : sql.length),
  };
}

/** Solo la sezione UP di un file di migrazione. */
export function extractUpSection(sql: string): string {
  return parseMigration(sql).up;
}

/** Solo la sezione DOWN: `null` quando il file non la definisce. */
export function extractDownSection(sql: string): string | null {
  return parseMigration(sql).down;
}

/**
 * Una sezione è eseguibile solo se contiene almeno uno statement: commenti,
 * separatori e righe vuote non contano. È la guardia che impedisce a un
 * rollback di dichiarare successo senza aver toccato lo schema.
 */
export function hasSqlStatements(section: string): boolean {
  return (
    section
      // Commenti a blocco e a riga fuori dal conteggio; i blocchi `$$ … $$`
      // restano, quindi una `DO` con il corpo commentato conteggia comunque.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .trim() !== ''
  );
}

/**
 * Ledger creato dal runner stesso (e replicato in `schema.sql` per chi legge lo
 * schema completo in un colpo solo): non serve preparare nulla a mano prima
 * del primo `migrate:up`.
 */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_LEDGER} (
  id SERIAL PRIMARY KEY,
  version VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

let pool: Pool | null = null;

/**
 * Pool creato alla prima migrazione, non a import-time: `server/index.ts`
 * carica il `.env` nel corpo del proprio modulo (dopo l'import di questo
 * file), quindi leggere `process.env` durante l'import vedrebbe solo
 * l'ambiente del processo e ripiegherebbe su valori sbagliati. La
 * configurazione arriva da `loadDatabaseConfig`, l'unica sorgente usata anche
 * da `db:check` e dal servizio: `DATABASE_URL` con precedenza sulle `DB_*`.
 */
function getPool(): Pool {
  if (pool) return pool;
  const config = loadDatabaseConfig();
  pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    ssl: config.ssl,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectTimeoutMs,
  });
  return pool;
}

/** Una sessione dedicata dal pool: transazione e advisory lock sono di sessione. */
async function acquireConnection(): Promise<MigrationConnection> {
  const client = await getPool().connect();
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      const result = await client.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      // Senza parametri `pg` usa il simple query protocol: una sola chiamata
      // può contenere più statement e i blocchi `DO $$ … $$` dei file.
      await client.query(sql);
    },
    release: () => client.release(),
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Advisory lock a livello di transazione: `pg_try_advisory_xact_lock` non
 * blocca la connessione, quindi si può registrare l'attesa e fallire con un
 * errore chiaro invece di restare appesi per sempre nel bootstrap. Il lock si
 * libera da sé al COMMIT/ROLLBACK, anche se il processo muore.
 */
async function acquireMigrationLock(
  connection: MigrationConnection,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let waiting = false;

  for (;;) {
    const { rows } = await connection.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS locked',
      [MIGRATIONS_LOCK_KEY],
    );
    if (rows[0]?.locked === true) return;

    if (!waiting) {
      log('[migrate] un’altra istanza sta migrando il database: attendo il lock…');
      waiting = true;
    }
    if (Date.now() >= deadline) {
      throw new MigrationError(
        'LOCK_TIMEOUT',
        `advisory lock di migrazione non acquisito entro ${timeoutMs} ms: un’altra ` +
          'istanza sta applicando lo schema (avvii concorrenti o processo rimasto bloccato)',
      );
    }
    await delay(LOCK_RETRY_MS);
  }
}

/**
 * Un valore non utilizzabile non deve mai *disattivare* la protezione: `0`,
 * negativo o `NaN` tornano al default, non a "nessun timeout".
 */
function ddlTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

/**
 * Applica `lock_timeout` e `statement_timeout` **alla sola transazione** in
 * corso (`SET LOCAL`): al COMMIT/ROLLBACK tornano i valori di sessione, quindi
 * la policy non si propaga alle query dell'applicazione che condividono la
 * stessa connessione del pool.
 *
 * I millisecondi sono numeri interi validati da `ddlTimeoutMs`: il testo SQL
 * contiene solo cifre, nessun frammento proveniente dall'esterno.
 */
async function applyDdlTimeouts(
  connection: MigrationConnection,
  options: DdlTimeoutOptions,
): Promise<DdlTimeouts> {
  const timeouts: DdlTimeouts = {
    lockTimeoutMs: ddlTimeoutMs(options.ddlLockTimeoutMs, DEFAULT_DDL_LOCK_TIMEOUT_MS),
    statementTimeoutMs: ddlTimeoutMs(
      options.ddlStatementTimeoutMs,
      DEFAULT_DDL_STATEMENT_TIMEOUT_MS,
    ),
  };

  try {
    await connection.exec(`SET LOCAL lock_timeout = '${timeouts.lockTimeoutMs}ms'`);
    await connection.exec(`SET LOCAL statement_timeout = '${timeouts.statementTimeoutMs}ms'`);
  } catch (error) {
    throw new MigrationError(
      'SQL_ERROR',
      `impossibile applicare la policy DDL (lock_timeout ${timeouts.lockTimeoutMs} ms, ` +
        `statement_timeout ${timeouts.statementTimeoutMs} ms): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return timeouts;
}

/**
 * Transazione attorno a un ciclo di migrazione: un fallimento a metà non deve
 * lasciare DDL applicato senza la riga nel ledger. Il ROLLBACK è esplicito
 * perché una sessione che torna al pool "idle in transaction" continuerebbe a
 * trattenere i lock.
 *
 * I timeout DDL vengono impostati subito dopo il `BEGIN`, prima di qualunque
 * statement: è l'unico punto in cui `SET LOCAL` vale per tutti i file applicati
 * nella stessa transazione (l'advisory lock è di transazione, quindi il ciclo
 * non si può spezzare in più transazioni senza perdere la mutua esclusione).
 */
async function withTransaction<T>(
  connection: MigrationConnection,
  run: (timeouts: DdlTimeouts) => Promise<T>,
  options: DdlTimeoutOptions = {},
): Promise<T> {
  await connection.exec('BEGIN');
  try {
    const timeouts = await applyDdlTimeouts(connection, options);
    const result = await run(timeouts);
    await connection.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.exec('ROLLBACK');
    } catch {
      // Connessione già caduta: il pool la scarta da sé.
    }
    throw error;
  }
}

/** SQLSTATE che meritano il contesto della policy DDL nel messaggio. */
const TIMEOUT_HINTS: Record<string, string> = {
  '55P03': 'lock non acquisito entro lock_timeout',
  '57014': 'statement annullata da statement_timeout',
};

/**
 * Etichetta operativa per gli errori di timeout: chi legge il log deve sapere
 * quale limite è scattato e con quale valore, senza doverlo dedurre dal codice
 * PostgreSQL.
 */
function timeoutHint(error: unknown, timeouts: DdlTimeouts): string {
  const code = (error as { code?: unknown } | null)?.code;
  const hint = typeof code === 'string' ? TIMEOUT_HINTS[code] : undefined;
  if (!hint) return '';
  return (
    ` — ${hint} (lock_timeout ${timeouts.lockTimeoutMs} ms, ` +
    `statement_timeout ${timeouts.statementTimeoutMs} ms)`
  );
}

async function runMigrationSql(
  connection: MigrationConnection,
  sql: string,
  file: string,
  timeouts: DdlTimeouts,
): Promise<void> {
  try {
    await connection.exec(sql);
  } catch (error) {
    throw new MigrationError(
      'SQL_ERROR',
      `${file}: ${error instanceof Error ? error.message : String(error)}` +
        timeoutHint(error, timeouts),
      { cause: error },
    );
  }
}

function readMigrationFile(migrationDir: string, file: string): string {
  return fs.readFileSync(path.resolve(migrationDir, file), 'utf8');
}

async function applyMigrations(
  connection: MigrationConnection,
  migrationDir: string,
  options: MigrateOptions,
): Promise<MigrateUpResult> {
  const log = options.log ?? console.log;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  return withTransaction(
    connection,
    async (timeouts) => {
      // Il lock viene prima di qualunque lettura: è ciò che rende la decisione
      // "questa migrazione è già stata applicata" affidabile fra processi.
      await acquireMigrationLock(connection, lockTimeoutMs, log);
      await connection.exec(LEDGER_DDL);

      const { rows } = await connection.query<{ version: string }>(
        `SELECT version FROM ${MIGRATIONS_LEDGER}`,
      );
      const appliedVersions = new Set(rows.map((row) => row.version));
      const pending = listMigrationFiles(migrationDir).filter((file) => !appliedVersions.has(file));

      if (pending.length === 0) {
        log('[migrate] database già aggiornato: nessuna migrazione pendente');
        return { applied: [] };
      }

      for (const file of pending) {
        const sql = extractUpSection(readMigrationFile(migrationDir, file));
        if (!hasSqlStatements(sql)) {
          throw new MigrationError(
            'EMPTY_UP_SECTION',
            `la migrazione ${file} non contiene statement nella sezione UP`,
          );
        }
        log(`[migrate] applico ${file}`);
        await runMigrationSql(connection, sql, file, timeouts);
        // Ledger e DDL nella stessa transazione: registrato solo ciò che è stato
        // davvero applicato, senza finestre in cui il database è avanti al ledger.
        await connection.query(`INSERT INTO ${MIGRATIONS_LEDGER} (version) VALUES ($1)`, [file]);
      }

      return { applied: pending };
    },
    options,
  );
}

/**
 * Applica le migrazioni non ancora presenti nel ledger, in una sola
 * transazione protetta da advisory lock. Idempotente: la seconda esecuzione
 * consecutiva non esegue alcuna DDL.
 *
 * @throws {MigrationError} lock non acquisito, SQL fallito o ledger incoerente.
 */
export async function migrateUp(options: MigrateOptions = {}): Promise<MigrateUpResult> {
  const migrationDir = resolveMigrationDir(options.dir);
  const connection = options.connection ?? (await acquireConnection());
  const ownsConnection = options.connection === undefined;
  try {
    const result = await applyMigrations(connection, migrationDir, options);
    const log = options.log ?? console.log;
    if (result.applied.length > 0) {
      log(`[migrate] ${result.applied.length} migrazione(i) applicata(e)`);
    }
    return result;
  } finally {
    if (ownsConnection) connection.release?.();
  }
}

/**
 * Annulla l'ultima migrazione **registrata nel ledger**: esegue la sua sezione
 * DOWN e rimuove la riga, il tutto in una transazione protetta dallo stesso
 * advisory lock. `schema_migrations` è l'ordine di applicazione reale, non
 * l'ordine alfabetico dei file.
 *
 * @throws {MigrationError} nessuna migrazione applicata, file assente o
 * sezione DOWN mancante/vuota. In nessun caso la funzione riporta un successo
 * senza aver modificato lo schema.
 */
export async function migrateDown(options: MigrateOptions = {}): Promise<MigrateDownResult> {
  const migrationDir = resolveMigrationDir(options.dir);
  const connection = options.connection ?? (await acquireConnection());
  const ownsConnection = options.connection === undefined;
  const log = options.log ?? console.log;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  try {
    return await withTransaction(
      connection,
      async (timeouts) => {
        await acquireMigrationLock(connection, lockTimeoutMs, log);
        await connection.exec(LEDGER_DDL);

        const { rows } = await connection.query<{ version: string }>(
          `SELECT version FROM ${MIGRATIONS_LEDGER} ORDER BY id DESC LIMIT 1`,
        );
        const version = rows[0]?.version;
        if (!version) {
          throw new MigrationError(
            'NO_APPLIED_MIGRATIONS',
            'nessuna migrazione applicata: non c’è nulla da annullare',
          );
        }

        // La versione arriva dal database: il nome deve restare dentro la
        // cartella delle migrazioni, non un percorso arbitrario.
        const filePath = path.resolve(migrationDir, version);
        if (path.basename(version) !== version || !fs.existsSync(filePath)) {
          throw new MigrationError(
            'MISSING_MIGRATION_FILE',
            `il file della migrazione «${version}» non esiste in ${migrationDir}: ` +
              'ripristinalo prima di annullarla',
          );
        }

        const down = extractDownSection(fs.readFileSync(filePath, 'utf8'));
        if (down === null || !hasSqlStatements(down)) {
          throw new MigrationError(
            'NO_DOWN_SECTION',
            `la migrazione «${version}» non ha una sezione DOWN eseguibile: ` +
              'il rollback non è supportato, scrivila nel file prima di riprovare',
          );
        }

        log(`[migrate] annullo ${version}`);
        await runMigrationSql(connection, down, version, timeouts);
        await connection.query(`DELETE FROM ${MIGRATIONS_LEDGER} WHERE version = $1`, [version]);
        return { rolledBack: version };
      },
      options,
    );
  } finally {
    if (ownsConnection) connection.release?.();
  }
}

/**
 * Nome del file di migrazione richiesto dal lint (`tools/lint-naming-conventions.mjs`):
 * timestamp UTC a 14 cifre, underscore, descrizione in kebab-case.
 */
export const MIGRATION_FILE_PATTERN = /^\d{14}_[a-z0-9]+(-[a-z0-9]+)*\.sql$/;

/** Descrizione usata quando il nome fornito non lascia nulla di utile. */
export const FALLBACK_MIGRATION_NAME = 'unnamed-migration';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Timestamp UTC a 14 cifre (`YYYYMMDDHHmmss`) usato come prefisso delle nuove
 * migrazioni. Niente separatori: il nome deve ordinarsi alfabeticamente come si
 * ordina nel tempo, e un prefisso a larghezza fissa lo garantisce anche fra
 * anni diversi (a differenza di `001`, `002`, … che si ferma a tre cifre).
 */
export function formatMigrationTimestamp(date: Date = new Date()): string {
  return (
    `${date.getUTCFullYear()}` +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds())
  );
}

/**
 * Normalizza la descrizione libera in kebab-case: minuscolo, ogni sequenza di
 * caratteri non alfanumerici (spazi multipli, `_`, punteggiatura) diventa un
 * singolo trattino, niente trattini di testa o di coda. Gli accenti vengono
 * traslitterati (`Città` → `citta`) invece di sparire insieme alla lettera.
 *
 * `add  Solar_Inverter!` → `add-solar-inverter`, non `addsolarinverter`.
 */
export function kebabCaseMigrationName(name: string): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    // Segni diacritici scomposti da NFKD: restano solo le lettere base.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || FALLBACK_MIGRATION_NAME;
}

/** Nome completo del file: `<YYYYMMDDHHmmss>_<kebab-case>.sql`. */
export function buildMigrationFileName(name: string, date: Date = new Date()): string {
  return `${formatMigrationTimestamp(date)}_${kebabCaseMigrationName(name)}.sql`;
}

export interface CreateMigrationOptions {
  /** Directory di destinazione (default: `MIGRATION_DIR` o `server/migrations`). */
  dir?: string;
  /** Istante da usare nel nome (default: adesso). Iniettabile nei test. */
  now?: Date;
}

/**
 * Crea un nuovo file di migrazione con nome conforme alle convenzioni
 * (`YYYYMMDDHHmmss_add-solar-inverter.sql`) e il template UP/DOWN/END già
 * riconosciuto da `parseMigration`.
 *
 * I marcatori macchina restano `-- <file> - UP|DOWN|END` (l'unica forma che il
 * runner sa tagliare, e quella di tutte le migrazioni storiche); le righe
 * `-- Up Migration` / `-- Down Migration` sono le etichette leggibili richieste
 * dal template e non interferiscono con il parser.
 */
export async function createMigration(
  name: string,
  options: CreateMigrationOptions = {},
): Promise<{ success: boolean; error?: string; filePath?: string; filename?: string }> {
  try {
    const migrationDir = resolveMigrationDir(options.dir);
    const filename = buildMigrationFileName(name, options.now ?? new Date());
    const filePath = path.resolve(migrationDir, filename);

    if (fs.existsSync(filePath)) {
      return { success: false, error: `File already exists: ${filePath}` };
    }

    // Due migrazioni con lo stesso timestamp non sarebbero ordinabili in modo
    // stabile: il lint le blocca, qui evitiamo proprio di generararle.
    const prefix = filename.slice(0, 14);
    const collision = listMigrationFiles(migrationDir).find((file) => file.startsWith(`${prefix}_`));
    if (collision) {
      return {
        success: false,
        error:
          `Esiste già una migrazione con questo timestamp (${collision}): ` +
          'riprova fra un secondo, il prefisso deve essere unico',
      };
    }

    const content = `-- ----------------------------
-- ${filename} - UP
-- ----------------------------
-- Up Migration

-- Scrivi qui l'SQL della migrazione. UP e riga nel ledger girano nella stessa
-- transazione: se un solo statement fallisce, lo schema resta invariato.

-- ----------------------------
-- ${filename} - DOWN
-- ----------------------------
-- Down Migration

-- Annulla le modifiche della sezione UP (ordine inverso). Un DOWN vuoto blocca
-- \`migrate:down\` con NO_DOWN_SECTION: un rollback non deve dichiarare
-- successo senza aver toccato lo schema.

-- ----------------------------
-- ${filename} - END
-- ----------------------------
`;

    fs.writeFileSync(filePath, content, 'utf8');

    console.log(`[migrate] Created migration file: ${filePath}`);
    return { success: true, filePath, filename };
  } catch (error) {
    console.error('[migrate] Error creating migration:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Bootstrap: migra il database all'avvio. Un errore di schema è bloccante, ma
 * il processo chiamante (`server/index.ts`) riceve un esito strutturato invece
 * di un'eccezione da maneggiare nella sequenza di avvio.
 */
export async function bootstrapMigrations(): Promise<{ success: boolean; error?: string; applied?: number }> {
  try {
    const result = await migrateUp();
    if (result.applied.length === 0) {
      console.log('[migrate] Bootstrap completo: database già aggiornato');
    } else {
      console.log(`[migrate] Bootstrap completo: ${result.applied.length} migrazione(i) applicata(e)`);
    }
    return { success: true, applied: result.applied.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[migrate] Bootstrap fallito: ${message}`);
    return { success: false, error: message };
  }
}

// Confronto fra percorsi assoluti: costruire la URL a mano (`file://` +
// `process.argv[1]`) non regge su Windows, dove il percorso è `C:\...`, e la
// CLI restava muta (nessun comando eseguito, exit code 0).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = invokedPath !== '' && fileURLToPath(import.meta.url) === invokedPath;

// If run directly, execute migrations
if (isDirectRun) {
  try {
    // Stesso caricamento del servizio (`server/index.ts`), eseguito prima di
    // qualunque lettura della configurazione: `migrate:up` da riga di comando
    // deve vedere lo stesso `.env` di `npm run start:server`.
    loadEnvFile();
  } catch {
    // Nessun `.env` locale: valgono le variabili già presenti nell'ambiente.
  }

  /** Esito della CLI: 0 solo se l'operazione ha davvero modificato lo schema. */
  const run = (task: () => Promise<void>): void => {
    task()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };

  const command = process.argv[2];
  switch (command) {
    case 'up':
      run(async () => {
        await migrateUp();
      });
      break;
    case 'down':
      run(async () => {
        await migrateDown();
      });
      break;
    case 'create': {
      // Nome libero (anche più parole): la normalizzazione in kebab-case avviene
      // in `createMigration`, che ripiega su `unnamed-migration` se resta vuoto.
      const name = process.argv.slice(3).join(' ');
      void createMigration(name).then((result) => {
        console.log(
          result.success ? `[migrate] Creato ${result.filePath}` : `[migrate] ${result.error}`,
        );
        process.exit(result.success ? 0 : 1);
      });
      break;
    }
    default:
      console.log(
        'Usage: node server/migrate.ts <up|down|create> [name]\n' +
          '  create "add solar inverter" → server/migrations/<YYYYMMDDHHmmss>_add-solar-inverter.sql',
      );
      process.exit(1);
  }
}
