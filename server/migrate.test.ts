import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  extractDownSection,
  extractUpSection,
  hasSqlStatements,
  migrateDown,
  migrateUp,
  MigrationError,
  parseMigration,
  type MigrationConnection,
  type MigrationErrorCode,
} from './migrate.js';

const REAL_MIGRATION_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const noop = (): void => {};

const openEngines: PGlite[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Cartella temporanea con i file di migrazione del caso in esame. */
function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallos-migrations-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

/**
 * PostgreSQL vero (PGlite, lo stesso motore WASM dei test API) con una sola
 * sessione: la connessione registra gli statement, così i test possono
 * dimostrare che una DDL **non** è stata rieseguita.
 */
function setup() {
  const engine = new PGlite();
  openEngines.push(engine);
  const statements: string[] = [];

  const connection: MigrationConnection = {
    async query<T>(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      const result = await engine.query<T>(sql, params ? [...params] : undefined);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      statements.push(sql);
      await engine.exec(sql);
    },
  };

  return { connection, statements };
}

async function tableNames(connection: MigrationConnection, table: string): Promise<string[]> {
  const { rows } = await connection.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_name = $1',
    [table],
  );
  return rows.map((row) => row.table_name);
}

async function ledgerVersions(connection: MigrationConnection): Promise<string[]> {
  const { rows } = await connection.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY id',
  );
  return rows.map((row) => row.version);
}

/** Codice di un errore atteso, senza doverlo tipizzare come `MigrationError`. */
async function errorCodeOf(run: Promise<unknown>): Promise<MigrationErrorCode | 'NO_ERROR'> {
  try {
    await run;
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof MigrationError ? error.code : 'NO_ERROR';
  }
}

describe('estrazione delle sezioni UP / DOWN', () => {
  it('esegue solo la parte UP: il DOWN non deve cancellare lo schema all’avvio', () => {
    const sql = [
      'CREATE TABLE climate_schedules (id uuid);',
      '-- ----------------------------',
      '-- 003_add_climate_schedules.sql - DOWN',
      '-- ----------------------------',
      'DROP TABLE climate_schedules;',
    ].join('\n');

    const up = extractUpSection(sql);
    expect(up).toContain('CREATE TABLE climate_schedules');
    expect(up).not.toContain('DROP TABLE');
    expect(up).not.toContain('DOWN');
  });

  it('lascia intatto un file senza marcatore DOWN', () => {
    const sql = 'CREATE TABLE rooms (id text);';
    expect(extractUpSection(sql)).toBe(sql);
    expect(extractDownSection(sql)).toBeNull();
    expect(parseMigration(sql)).toEqual({ up: sql, down: null });
  });

  it('chiude la sezione DOWN sul marcatore END del template', () => {
    const sql = [
      '-- 007_prova.sql - UP',
      'CREATE TABLE prova (id int);',
      '-- 007_prova.sql - DOWN',
      'DROP TABLE prova;',
      '-- 007_prova.sql - END',
      '-- ----------------------------',
      'Non è SQL: questa parte non deve essere eseguita.',
    ].join('\n');

    expect(extractDownSection(sql)).toContain('DROP TABLE prova;');
    expect(extractDownSection(sql)).not.toContain('Non è SQL');
  });

  it('non scambia un END di blocco DO per un marcatore di sezione', () => {
    const sql = [
      '-- 008_prova.sql - UP',
      'DO $$',
      'BEGIN',
      '  IF EXISTS (SELECT 1) THEN',
      '    RAISE NOTICE \'ok\';',
      '  END IF;',
      'END',
      '$$;',
    ].join('\n');

    expect(parseMigration(sql)).toEqual({ up: sql, down: null });
  });

  it('riconosce una sezione senza statement (solo commenti e separatori)', () => {
    const empty = ['-- ----------------------------', '-- Revert the changes above', '-- ----------------------------'].join(
      '\n',
    );
    expect(hasSqlStatements(empty)).toBe(false);
    expect(hasSqlStatements('\n\n')).toBe(false);
    expect(hasSqlStatements('DROP TABLE rooms;')).toBe(true);
    // Un blocco DO con il corpo commentato è comunque eseguibile: la `DO` resta.
    expect(hasSqlStatements('DO $$\n-- niente\n$$\n;')).toBe(true);
  });
});

describe('migrateUp · ledger e idempotenza', () => {
  it('applica i file una volta sola e li registra nel ledger', async () => {
    const { connection, statements } = setup();

    const first = await migrateUp({ connection, dir: REAL_MIGRATION_DIR, log: noop });

    expect(first.applied).toContain('001_initial_schema.sql');
    expect(first.applied).toContain('004_automations.sql');
    expect(first.applied).toContain('006_kiosk_displays.sql');
    expect(await ledgerVersions(connection)).toEqual(first.applied);
    expect(await tableNames(connection, 'kiosk_displays')).toEqual(['kiosk_displays']);
    expect(await tableNames(connection, 'automations')).toEqual(['automations']);

    // Seconda esecuzione consecutiva: nessuna DDL rieseguita, ledger invariato.
    const mark = statements.length;
    const second = await migrateUp({ connection, dir: REAL_MIGRATION_DIR, log: noop });

    expect(second.applied).toEqual([]);
    expect(await ledgerVersions(connection)).toEqual(first.applied);
    const replayed = statements.slice(mark).join('\n');
    expect(replayed).not.toContain('kiosk_displays');
    expect(replayed).not.toContain('CREATE TABLE IF NOT EXISTS devices');
  });

  it('isola l’up: senza marcatore DOWN il file viene applicato per intero', async () => {
    const dir = makeTempDir({
      '001_senza_down.sql': 'CREATE TABLE senza_down (id int);\nINSERT INTO senza_down VALUES (1);\n',
    });
    const { connection } = setup();

    const result = await migrateUp({ connection, dir, log: noop });

    expect(result.applied).toEqual(['001_senza_down.sql']);
    expect(await tableNames(connection, 'senza_down')).toEqual(['senza_down']);
  });
});

describe('migrateDown · rollback reale', () => {
  it('esegue il DOWN, rimuove la riga dal ledger e lascia riapplicare la migrazione', async () => {
    const { connection } = setup();
    await migrateUp({ connection, dir: REAL_MIGRATION_DIR, log: noop });

    const rolled = await migrateDown({ connection, dir: REAL_MIGRATION_DIR, log: noop });

    expect(rolled.rolledBack).toBe('008_add_db_health_checks.sql');
    expect(await tableNames(connection, 'db_health_checks')).toEqual([]);
    // Le migrazioni precedenti restano applicate: si annulla solo l'ultima.
    expect(await tableNames(connection, 'floors')).toEqual(['floors']);
    expect(await ledgerVersions(connection)).not.toContain('008_add_db_health_checks.sql');

    // Riapplicare è possibile: il ledger è la fonte dell'ordine, non i file.
    const again = await migrateUp({ connection, dir: REAL_MIGRATION_DIR, log: noop });
    expect(again.applied).toEqual(['008_add_db_health_checks.sql']);
    expect(await tableNames(connection, 'db_health_checks')).toEqual(['db_health_checks']);
  });

  it('senza sezione DOWN solleva un errore esplicito e non tocca schema né ledger', async () => {
    const dir = makeTempDir({ '001_irreversibile.sql': 'CREATE TABLE irreversibile (id int);\n' });
    const { connection } = setup();
    await migrateUp({ connection, dir, log: noop });

    expect(await errorCodeOf(migrateDown({ connection, dir, log: noop }))).toBe('NO_DOWN_SECTION');
    expect(await tableNames(connection, 'irreversibile')).toEqual(['irreversibile']);
    expect(await ledgerVersions(connection)).toEqual(['001_irreversibile.sql']);
  });

  it('una sezione DOWN solo commenti (template appena creato) non è un rollback', async () => {
    const dir = makeTempDir({
      '001_template.sql': [
        '-- ----------------------------',
        '-- 001_template.sql - UP',
        '-- ----------------------------',
        'CREATE TABLE template (id int);',
        '-- ----------------------------',
        '-- 001_template.sql - DOWN',
        '-- ----------------------------',
        '-- Revert the changes made in the UP section above',
        '-- ----------------------------',
        '-- 001_template.sql - END',
        '-- ----------------------------',
      ].join('\n'),
    });
    const { connection } = setup();
    await migrateUp({ connection, dir, log: noop });

    expect(await errorCodeOf(migrateDown({ connection, dir, log: noop }))).toBe('NO_DOWN_SECTION');
    expect(await ledgerVersions(connection)).toEqual(['001_template.sql']);
  });

  it('con il ledger vuoto fallisce invece di riportare un finto successo', async () => {
    const { connection } = setup();

    expect(await errorCodeOf(migrateDown({ connection, dir: REAL_MIGRATION_DIR, log: noop }))).toBe(
      'NO_APPLIED_MIGRATIONS',
    );
  });

  it('un file applicato e poi sparito dal disco blocca il rollback', async () => {
    const dir = makeTempDir({
      '001_effimera.sql': 'CREATE TABLE effimera (id int);\n-- 001_effimera.sql - DOWN\nDROP TABLE effimera;\n',
    });
    const { connection } = setup();
    await migrateUp({ connection, dir, log: noop });
    fs.rmSync(path.join(dir, '001_effimera.sql'));

    expect(await errorCodeOf(migrateDown({ connection, dir, log: noop }))).toBe(
      'MISSING_MIGRATION_FILE',
    );
    expect(await tableNames(connection, 'effimera')).toEqual(['effimera']);
  });
});

describe('transazione unica del ciclo di migrazione', () => {
  it('se una migrazione fallisce, le precedenti della stessa esecuzione sono annullate', async () => {
    const dir = makeTempDir({
      '001_buona.sql': 'CREATE TABLE buona (id int);\n',
      '002_rotta.sql': 'CREATE TABLE rotta (id int);\nQUESTO NON È SQL;\n',
    });
    const { connection } = setup();

    expect(await errorCodeOf(migrateUp({ connection, dir, log: noop }))).toBe('SQL_ERROR');

    // Nessuna DDL sopravvive: nemmeno il ledger, creato dal runner nella
    // stessa transazione, resta dietro a una migrazione fallita.
    expect(await tableNames(connection, 'buona')).toEqual([]);
    expect(await tableNames(connection, 'rotta')).toEqual([]);
    expect(await tableNames(connection, 'schema_migrations')).toEqual([]);

    // Il bootstrap successivo riparte da zero e applica il file corretto.
    fs.rmSync(path.join(dir, '002_rotta.sql'));
    const retry = await migrateUp({ connection, dir, log: noop });
    expect(retry.applied).toEqual(['001_buona.sql']);
    expect(await tableNames(connection, 'buona')).toEqual(['buona']);
  });
});

/**
 * Cluster PostgreSQL in miniatura: ledger condiviso fra più sessioni e advisory
 * lock che serializza davvero. Serve a provare la mutua esclusione fra processi
 * concorrenti, che PGlite (una sola sessione) non può rappresentare.
 */
function createFakeCluster(files: Record<string, { up: string; down: string }>) {
  const bodies = new Set(Object.values(files).flatMap((file) => [file.up, file.down]));
  const ledger: string[] = [];
  const bodyRuns: string[] = [];
  let lockHolder: symbol | null = null;

  function connect() {
    const session = Symbol('session');
    const statements: string[] = [];

    const connection: MigrationConnection = {
      async query<T>(sql: string, params?: readonly unknown[]) {
        statements.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) {
          if (lockHolder === null || lockHolder === session) {
            lockHolder = session;
            return { rows: [{ locked: true } as T] };
          }
          return { rows: [{ locked: false } as T] };
        }
        if (sql.startsWith('SELECT version FROM schema_migrations')) {
          const versions = sql.includes('ORDER BY id DESC') ? [...ledger].reverse() : [...ledger];
          return { rows: versions.map((version) => ({ version }) as T) };
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
          ledger.push(String(params?.[0]));
          return { rows: [] };
        }
        if (sql.startsWith('DELETE FROM schema_migrations')) {
          const index = ledger.indexOf(String(params?.[0]));
          if (index >= 0) ledger.splice(index, 1);
          return { rows: [] };
        }
        throw new Error(`query non prevista dal finto cluster: ${sql}`);
      },
      async exec(sql: string) {
        statements.push(sql);
        const body = sql.trim();
        if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') {
          // Il lock di transazione si libera da sé alla fine della transazione.
          if (body !== 'BEGIN' && lockHolder === session) lockHolder = null;
          return;
        }
        if (body.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return;
        if (!bodies.has(body)) {
          throw new Error(`statement non previsto dal finto cluster: ${body}`);
        }
        bodyRuns.push(body);
      },
    };

    return { connection, statements };
  }

  return {
    connect,
    ledger,
    bodyRuns,
    /** Lock già occupato da un'altra istanza che non lo rilascia mai. */
    holdLock: () => {
      lockHolder = Symbol('altra-istanza');
    },
  };
}

const ALPHA = { up: 'CREATE TABLE alpha (id int);', down: 'DROP TABLE alpha;' };
const BETA = { up: 'CREATE TABLE beta (id int);', down: 'DROP TABLE beta;' };
const ALPHA_FILE = '001_alpha.sql';
const BETA_FILE = '002_beta.sql';

/** File su disco con la sezione UP (e, se richiesta, la DOWN). */
function alphaMigration(withDown = false): string {
  const down = withDown ? `-- ${ALPHA_FILE} - DOWN\n${ALPHA.down}\n` : '';
  return `${ALPHA.up}\n${down}`;
}

describe('concorrenza fra istanze', () => {
  it('due esecuzioni simultanee applicano ogni migrazione una volta sola', async () => {
    const dir = makeTempDir({
      [ALPHA_FILE]: alphaMigration(),
      [BETA_FILE]: `${BETA.up}\n`,
    });
    const cluster = createFakeCluster({ [ALPHA_FILE]: ALPHA, [BETA_FILE]: BETA });

    // Due sessioni che partono insieme: il lock serializza, chi arriva secondo
    // rilegge il ledger e non riapplica nulla.
    const [first, second] = await Promise.all([
      migrateUp({ connection: cluster.connect().connection, dir, log: noop }),
      migrateUp({ connection: cluster.connect().connection, dir, log: noop }),
    ]);

    const applied = [...first.applied, ...second.applied].sort();
    expect(applied).toEqual([ALPHA_FILE, BETA_FILE]);
    expect([first.applied.length, second.applied.length].sort()).toEqual([0, 2]);
    expect(cluster.ledger).toEqual([ALPHA_FILE, BETA_FILE]);
    // Ogni corpo eseguito esattamente una volta: nessuna DDL duplicata.
    expect(cluster.bodyRuns).toHaveLength(2);
  });

  it('acquisisce il lock prima di leggere il ledger e di eseguire la DDL', async () => {
    const dir = makeTempDir({ [ALPHA_FILE]: alphaMigration() });
    const cluster = createFakeCluster({ [ALPHA_FILE]: ALPHA });
    const session = cluster.connect();

    await migrateUp({ connection: session.connection, dir, log: noop });

    const lock = session.statements.findIndex((sql) => sql.includes('pg_try_advisory_xact_lock'));
    const ledgerRead = session.statements.findIndex((sql) =>
      sql.startsWith('SELECT version FROM schema_migrations'),
    );
    const firstBody = session.statements.findIndex((sql) => sql.trim() === ALPHA.up);

    expect(session.statements[0]).toBe('BEGIN');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(ledgerRead);
    expect(lock).toBeLessThan(firstBody);
    // Tutto in una sola transazione, chiusa con COMMIT.
    expect(session.statements.at(-1)).toBe('COMMIT');
  });

  it('se il lock resta occupato fallisce con LOCK_TIMEOUT invece di restare appeso', async () => {
    const dir = makeTempDir({ [ALPHA_FILE]: alphaMigration() });
    const cluster = createFakeCluster({ [ALPHA_FILE]: ALPHA });
    cluster.holdLock();
    const logs: string[] = [];

    expect(
      await errorCodeOf(
        migrateUp({
          connection: cluster.connect().connection,
          dir,
          log: (message) => logs.push(message),
          lockTimeoutMs: 50,
        }),
      ),
    ).toBe('LOCK_TIMEOUT');

    expect(logs.join('\n')).toContain('attendo il lock');
    expect(cluster.bodyRuns).toEqual([]);
  });

  it('il rollback concorrente attende il lock e non esegue un DOWN doppio', async () => {
    const dir = makeTempDir({ [ALPHA_FILE]: alphaMigration(true) });
    const cluster = createFakeCluster({ [ALPHA_FILE]: ALPHA });
    await migrateUp({ connection: cluster.connect().connection, dir, log: noop });

    const results = await Promise.allSettled([
      migrateDown({ connection: cluster.connect().connection, dir, log: noop }),
      migrateDown({ connection: cluster.connect().connection, dir, log: noop }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    // Il secondo trova il ledger vuoto: errore, non un successo senza modifiche.
    expect(rejected).toHaveLength(1);
    // Un solo DOWN eseguito: il corpo dell'UP era già nel registro dei run.
    expect(cluster.bodyRuns.filter((sql) => sql === ALPHA.down)).toHaveLength(1);
    expect(cluster.ledger).toEqual([]);
  });
});
