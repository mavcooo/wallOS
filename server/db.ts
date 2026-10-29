import { readFileSync } from 'node:fs';

import { Pool } from 'pg';

import type { DevicePinPosition, RoomGridLayout } from '../src/types/floorplan.js';
import type {
  AttemptPolicy,
  AttemptRow,
  AutomationActionOutcome,
  AutomationLogRow,
  AutomationRow,
  AutomationTriggerType,
  AutomationWithLastLogRow,
  ClimatePreset,
  ClimateRuntimeRow,
  ClimateScheduleRow,
  DeviceRow,
  FloorFields,
  FloorRow,
  KioskDisplayFields,
  KioskDisplayRow,
  RefreshTokenRow,
  RoomRow,
  ScenarioRow,
  UserRole,
  UserRow,
} from './types.js';
import { INVALID_DATABASE_TARGET, sanitizeDatabaseUrl } from './utils/sanitize.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** Interfaccia minima condivisa da `pg.Pool` e PGlite (test). */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  /** Solo PGlite nei test: il pool `pg` chiude da sé. */
  close?(): Promise<void>;
}

export interface DatabaseOptions {
  connectionString: string;
  max?: number;
  /** Connessioni inattive chiuse dopo questo tempo (default 30 s). */
  idleTimeoutMillis?: number;
  ssl?: boolean;
  connectionTimeoutMillis?: number;
  /** TCP keep-alive sui socket del pool (default `true`). */
  keepAlive?: boolean;
  /** Ritardo del primo probe keep-alive in ms (default 10 s). */
  keepAliveInitialDelayMillis?: number;
  /** Client esterno (PGlite nei test): in quel caso il pool non viene creato. */
  client?: SqlClient;
}

export interface NewUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  role: UserRole;
  pinHash: string;
  pinLength: 4 | 5 | 6;
  isKioskDevice: boolean;
  kioskDeviceId: string | null;
  allowedRooms: string[] | null;
}

export interface UserFields {
  username?: string;
  displayName?: string;
  passwordHash?: string | null;
  role?: UserRole;
  pinHash?: string;
  pinLength?: 4 | 5 | 6;
  isKioskDevice?: boolean;
  kioskDeviceId?: string | null;
  allowedRooms?: string[] | null;
  active?: boolean;
}

export interface NewRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  kind: 'user' | 'kiosk';
  expiresAt: number;
  userAgent: string | null;
}

export interface NewRoom {
  id: string;
  name: string;
  shortLabel: string | null;
  icon: string;
  displayOrder: number;
  /** Piano della planimetria (default: nessuno, l'editor lo assegna). */
  floorId?: string | null;
  gridLayout?: RoomGridLayout;
}

/** Stanza dentro il salvataggio bulk del layout. */
export interface FloorLayoutRoomUpdate {
  id: string;
  /** `undefined` = resta il piano corrente, `null` = nessun piano. */
  floorId?: string | null;
  gridLayout: RoomGridLayout;
}

/** Marker dispositivo dentro il salvataggio bulk del layout. */
export interface FloorLayoutDeviceUpdate {
  id: string;
  roomPinPosition: DevicePinPosition;
}

export interface NewDevice {
  id: string;
  roomId: string;
  name: string;
  type: 'light' | 'climate' | 'power' | 'media' | 'sensor' | 'camera';
  adapter: string;
  model: string | null;
  stateTopic: string;
  commandTopic: string | null;
  availabilityTopic: string | null;
  fieldMap: Record<string, string> | null;
  streamUrl: string | null;
  snapshotUrl: string | null;
  streamProtocol: 'webrtc' | 'hls' | 'mjpeg' | 'auto' | null;
  aspectRatio: '16:9' | '4:3' | null;
  metadata: Record<string, unknown>;
  favorite: boolean;
  protected: boolean;
  displayOrder: number;
  roomPinPosition?: DevicePinPosition;
}

export interface NewScenario {
  id: string;
  name: string;
  description: string;
  icon: string;
  protected: boolean;
  actions: unknown;
  displayOrder: number;
}

/**
 * Campi modificabili di una stanza (l'id è la chiave, non si riscrive).
 * Tutti opzionali: il PATCH è parziale e i campi assenti restano invariati.
 */
export interface RoomUpdate {
  name?: string;
  shortLabel?: string | null;
  icon?: string;
  displayOrder?: number;
}

/** Strategia sui dispositivi collegati quando si elimina una stanza. */
export type RoomOrphanStrategy = 'restrict' | 'unassign' | 'cascade';

/** Stanza di raccolta dei dispositivi senza stanza (seed: “Non assegnati”). */
export const UNASSIGNED_ROOM_ID = 'unassigned';

/**
 * Esito della cancellazione di una stanza in transazione.
 * `not_empty` e `unassigned_room_missing` sono conflitti: la transazione fa
 * ROLLBACK e il database resta esattamente com'era.
 */
export type RoomDeletionResult =
  | { status: 'deleted'; devices: number }
  | { status: 'not_found' }
  | { status: 'not_empty'; devices: number }
  | { status: 'unassigned_room_missing'; devices: number };

/** Colonna fisica di una chiave API; `json` = parametro castato a jsonb. */
interface ColumnSpec {
  column: string;
  json?: boolean;
}

/**
 * Whitelist delle colonne scrivibili via PATCH: l'unica traduzione ammessa tra
 * payload e SQL. `buildUpdateSet` itera su questa mappa e **mai** sulle chiavi
 * del body, quindi un campo non censito non può finire nel testo della query.
 */
const ROOM_UPDATE_COLUMNS = {
  name: { column: 'name' },
  shortLabel: { column: 'short_label' },
  icon: { column: 'icon' },
  displayOrder: { column: 'display_order' },
} as const satisfies Record<keyof RoomUpdate, ColumnSpec>;

/** Campi modificabili di un device; `fieldMap`/`metadata` sono opzionali. */
export interface DeviceFields {
  roomId: string;
  name: string;
  type: NewDevice['type'];
  adapter: string;
  model: string | null;
  stateTopic: string;
  commandTopic: string | null;
  availabilityTopic: string | null;
  streamUrl: string | null;
  snapshotUrl: string | null;
  streamProtocol: 'webrtc' | 'hls' | 'mjpeg' | 'auto' | null;
  aspectRatio: '16:9' | '4:3' | null;
  favorite: boolean;
  protected: boolean;
  displayOrder: number;
  fieldMap?: Record<string, string> | null;
  metadata?: Record<string, unknown>;
}

/**
 * Campi aggiornabili di un device via PATCH parziale: gli stessi che espone il
 * form admin. Un campo assente non viene toccato (niente reset a NULL).
 */
export interface DeviceUpdate {
  roomId?: string;
  name?: string;
  type?: NewDevice['type'];
  adapter?: string;
  model?: string | null;
  stateTopic?: string;
  commandTopic?: string | null;
  availabilityTopic?: string | null;
  favorite?: boolean;
  protected?: boolean;
  displayOrder?: number;
  fieldMap?: Record<string, string> | null;
  metadata?: Record<string, unknown>;
  roomPinPosition?: DevicePinPosition;
  streamUrl?: string | null;
  snapshotUrl?: string | null;
  streamProtocol?: 'webrtc' | 'hls' | 'mjpeg' | 'auto' | null;
  aspectRatio?: '16:9' | '4:3' | null;
}

/** Whitelist chiave API → colonna SQL per `PATCH /api/devices/:id`. */
const DEVICE_UPDATE_COLUMNS = {
  roomId: { column: 'room_id' },
  name: { column: 'name' },
  type: { column: 'type' },
  adapter: { column: 'adapter' },
  model: { column: 'model' },
  stateTopic: { column: 'state_topic' },
  commandTopic: { column: 'command_topic' },
  availabilityTopic: { column: 'availability_topic' },
  favorite: { column: 'favorite' },
  protected: { column: 'protected' },
  displayOrder: { column: 'display_order' },
  fieldMap: { column: 'field_map', json: true },
  metadata: { column: 'metadata', json: true },
  roomPinPosition: { column: 'room_pin_position', json: true },
  streamUrl: { column: 'stream_url' },
  snapshotUrl: { column: 'snapshot_url' },
  streamProtocol: { column: 'stream_protocol' },
  aspectRatio: { column: 'aspect_ratio' },
} as const satisfies Record<keyof DeviceUpdate, ColumnSpec>;

/**
 * Costruisce la clausola SET di un UPDATE parziale.
 *
 * L'iterazione è sulla whitelist, non sul payload: le chiavi che arrivano dal
 * client servono solo a leggere un valore, mai a comporre SQL. I nomi colonna
 * provengono da letterali del modulo e i valori sono sempre parametri
 * posizionali ($1, $2, …).
 */
function buildUpdateSet<K extends string>(
  whitelist: Readonly<Record<K, ColumnSpec>>,
  values: Partial<Record<K, unknown>>,
): { assignments: string[]; params: unknown[] } {
  const assignments: string[] = [];
  const params: unknown[] = [];

  for (const key of Object.keys(whitelist) as K[]) {
    const value = values[key];
    if (value === undefined) continue;
    const spec = whitelist[key];
    params.push(spec.json ? JSON.stringify(value) : value);
    assignments.push(`"${spec.column}" = $${params.length}${spec.json ? '::jsonb' : ''}`);
  }

  return { assignments, params };
}

export interface ScenarioFields {
  name: string;
  description: string;
  icon: string;
  protected: boolean;
  actions: unknown;
  displayOrder: number;
}

/** Fascia oraria validata dalle route, pronta per la scrittura bulk. */
export interface ClimateScheduleInput {
  dayOfWeek: number;
  /** `HH:MM` o `HH:MM:SS`; `24:00` è accettato per fine giornata. */
  startTime: string;
  endTime: string;
  targetTemp: number;
  preset: ClimatePreset;
  isActive: boolean;
}

/** Override manuale. `until: null` = permanente, fino a cancellazione. */
export interface ClimateOverrideInput {
  targetTemp: number | null;
  preset: ClimatePreset | null;
  until: Date | null;
}

/** Campi di una regola di automazione, già validati dalle route. */
export interface AutomationFields {
  name: string;
  description: string | null;
  isActive: boolean;
  triggerType: AutomationTriggerType;
  triggerConfig: unknown;
  /** Primo gruppo di condizioni (AND). */
  conditions: unknown;
  /** Altri gruppi di condizioni (OR fra i gruppi). */
  conditionGroups: unknown;
  actions: unknown;
}

/** Esito di una valutazione, pronto per `automation_logs`. */
export interface NewAutomationLog {
  automationId: string;
  triggerSource: string;
  conditionsMet: boolean;
  actionsExecuted: AutomationActionOutcome[];
  executionTimeMs: number;
  errorMessage: string | null;
  /** Istante della ricezione del trigger (default: adesso). */
  triggeredAt?: Date;
}

export type AuthDb = Database;

export interface FailureResult {
  /** Fallimenti nella finestra corrente; 0 se è scattato il lockout. */
  failures: number;
  lockedUntil: number;
}

export interface ServerInfo {
  /** Stringa completa di `version()` (es. "PostgreSQL 17.4 on x86_64..."). */
  version: string;
  database: string;
  user: string;
}

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** "PostgreSQL 17.4 on x86_64..." → "PostgreSQL 17.4" per log e health. */
export function shortVersion(version: string): string {
  const [product, release] = version.split(' ');
  return product && release ? `${product} ${release}` : version;
}

/** Geometria di default della stanza: identica al DEFAULT della migrazione. */
export const DEFAULT_GRID_LAYOUT: RoomGridLayout = {
  col: 1,
  row: 1,
  colSpan: 3,
  rowSpan: 2,
  color: 'zinc',
};

/** Centro della stanza: marker di default quando il device non ne ha uno. */
export const DEFAULT_PIN_POSITION: DevicePinPosition = { x: 50, y: 50 };

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalizza `rooms.grid_layout` in un rettangolo sempre dentro la griglia
 * 12×8: una riga scritta a mano (o da una versione precedente) non deve mai
 * far uscire una stanza dal canvas di un pannello.
 */
export function normalizeGridLayout(value: unknown): RoomGridLayout {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const colSpan = clamp(Math.round(finiteNumber(record.colSpan, 3)), 1, 12);
  const rowSpan = clamp(Math.round(finiteNumber(record.rowSpan, 2)), 1, 8);
  return {
    col: clamp(Math.round(finiteNumber(record.col, 1)), 1, 12 - colSpan + 1),
    row: clamp(Math.round(finiteNumber(record.row, 1)), 1, 8 - rowSpan + 1),
    colSpan,
    rowSpan,
    color: typeof record.color === 'string' && record.color.length > 0 ? record.color : 'zinc',
  };
}

/** Marker sempre dentro il perimetro della stanza (percentuale 0-100). */
export function normalizePinPosition(value: unknown): DevicePinPosition {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    x: clamp(finiteNumber(record.x, 50), 0, 100),
    y: clamp(finiteNumber(record.y, 50), 0, 100),
  };
}

/** PG restituisce Date; un driver di test può restituire la stringa ISO. */
export function timestampMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parametri di resilienza del pool condiviso. I timeout arrivano dalla
 * configurazione (`DATABASE_*`); il keep-alive TCP è fisso: su una LAN con
 * router/switch che scartano sessioni NAT silenziosamente è l'unica difesa
 * prima che la query successiva trovi un socket morto.
 */
export const POOL_DEFAULTS = {
  max: 10,
  /** Client inattivi chiusi dopo 30 s: niente connessioni appese al DB. */
  idleTimeoutMillis: 30_000,
  /** Fallisce in fretta se il DB è irraggiungibile, invece di restare appeso. */
  connectionTimeoutMillis: 5_000,
  /** TCP keep-alive a livello socket (SO_KEEPALIVE). */
  keepAlive: true,
  /** Primo probe dopo 10 s: sotto il tipico idle timeout di NAT/firewall. */
  keepAliveInitialDelayMillis: 10_000,
} as const;

/** Parametri del pool condiviso, derivati dalle variabili `DB_*`/`DATABASE_URL`. */
export interface DatabasePoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  ssl: boolean;
}

/**
 * `postgres://utente:password@host:5432/db` → `host:5432/db`.
 * La sanitizzazione vive in `utils/sanitize.ts`, condivisa con il bootstrap:
 * una sola implementazione, nessuna possibilità di reintrodurre la URL grezza.
 */
export function describeDatabaseTarget(connectionString: string): string {
  const target = sanitizeDatabaseUrl(connectionString);
  return target === INVALID_DATABASE_TARGET ? 'destinazione PostgreSQL sconosciuta' : target;
}

/**
 * Suggerimento operativo senza credenziali: il messaggio non riporta né la
 * password né il nome utente, così anche i log di errore all'avvio possono
 * essere condivisi in un ticket senza esporre il ruolo del database.
 */
export function describeDatabaseError(error: unknown, connectionString: string): string {
  let database = 'sconosciuto';
  try {
    const parsed = new URL(connectionString);
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) || database;
  } catch {
    // URL già validata da loadConfig: qui si arriva solo con valori strani.
  }

  const target = describeDatabaseTarget(connectionString);
  const code = (error as { code?: unknown } | null)?.code;
  const detail = error instanceof Error ? error.message : String(error);

  switch (code) {
    case '28P01':
      return (
        `PostgreSQL ha rifiutato la password per ${target}. ` +
        `Allinea DATABASE_URL/DB_PASSWORD con le credenziali reali (es. postgres://utente:password@${target}).`
      );
    case '28000':
      return `L'utente configurato non è autorizzato a connettersi a ${target} (pg_hba.conf).`;
    case '3D000':
      return (
        `Il database "${database}" non esiste su ${target}: crealo (createdb ${database}) ` +
        'oppure punta DATABASE_URL/DB_NAME al database giusto.'
      );
    case 'ECONNREFUSED':
      return `Nessun PostgreSQL in ascolto su ${target}: controlla che il servizio sia attivo e la porta 5432 aperta.`;
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Il server PostgreSQL ${target} non è raggiungibile dalla rete: verifica IP, firewall e VLAN del pannello.`;
    case 'ENOTFOUND':
      return `Host PostgreSQL non risolto (${target}): usa un IP della LAN invece di un hostname mDNS.`;
    default:
      return `Connessione a PostgreSQL ${target} non riuscita: ${detail}`;
  }
}

/** Adattatore `pg.Pool` → `SqlClient` (stessa interfaccia dei test PGlite). */
export function createSqlClient(pool: Pool): SqlClient {
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      const result = await pool.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
  };
}

let sharedPool: Pool | null = null;

/** Crea un pool `pg` con timeout espliciti e gestione degli errori non fatali. */
export function createPool(config: DatabasePoolConfig): Pool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    // Un socket inattivo può morire senza FIN (riavvio di PostgreSQL, cavo
    // sfilato, sessione NAT scartata dal router). Il keep-alive TCP lo scopre
    // mentre il client è ancora nel pool, così `pg` lo elimina e la query
    // successiva apre una connessione nuova invece di fallire.
    keepAlive: config.keepAlive,
    keepAliveInitialDelayMillis: config.keepAliveInitialDelayMillis,
    application_name: 'wallos-auth',
    ...(config.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // Un client idle che muore (riavvio di PostgreSQL, cavo di rete, host
  // 192.168.0.59 spento) emette 'error' sul pool: senza listener Node lo
  // tratterebbe come eccezione non gestita e terminerebbe il processo.
  pool.on('error', (error) => {
    const code = (error as { code?: unknown }).code;
    console.error(
      `[db] connessione inattiva persa${typeof code === 'string' ? ` (${code})` : ''}: ` +
        `${error.message} — il pool riproverà alla prossima query`,
    );
  });

  return pool;
}

/**
 * Pool condiviso dal processo: lo usano API, migrazione dello schema, seed e
 * gli script di utilità (`db:check`), così le connessioni non si moltiplicano.
 */
export function getPool(config: DatabasePoolConfig): Pool {
  sharedPool ??= createPool(config);
  return sharedPool;
}

/** Chiude il pool condiviso (shutdown del servizio, fine di uno script). */
export async function closePool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  await pool?.end();
}

function requirePool(): Pool {
  if (!sharedPool) {
    throw new Error(
      '[db] pool non inizializzato: chiama getPool(config) o buildApp() prima di query()',
    );
  }
  return sharedPool;
}

/**
 * Helper tipizzato per query una-tantum sul pool condiviso (script, job, test
 * manuali). Il repository dell'app usa comunque `Database`.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  const result = await requirePool().query(sql, params ? [...params] : undefined);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/** Query di identità: una sola andata e ritorno, nessun segreto. */
const SERVER_INFO_SQL =
  'SELECT version() AS version, current_database() AS database, current_user AS username';

interface ServerInfoRow {
  version: string;
  database: string;
  username: string;
}

function toServerInfo(row: ServerInfoRow | undefined): ServerInfo {
  return {
    version: row?.version ?? 'versione sconosciuta',
    database: row?.database ?? 'database sconosciuto',
    user: row?.username ?? 'utente sconosciuto',
  };
}

/** Identità del server per log e health: nessun segreto, una sola query. */
export async function readServerInfo(client: SqlClient): Promise<ServerInfo> {
  const { rows } = await client.query<ServerInfoRow>(SERVER_INFO_SQL);
  return toServerInfo(rows[0]);
}

export interface DatabaseHealth {
  healthy: boolean;
  /** Tempo di acquisizione del client + query, assente se il pool non esiste. */
  latencyMs?: number;
  /** Codice PostgreSQL/Node (es. `ECONNREFUSED`) o messaggio di fallback. */
  error?: string;
  /** Identità del server, presente solo quando la connessione risponde. */
  server?: ServerInfo;
}

function isPgPool(target: Pool | SqlClient): target is Pool {
  return typeof (target as Pool).connect === 'function';
}

/** Codice del driver se disponibile, altrimenti il messaggio: mai credenziali. */
function healthErrorLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'DATABASE_UNAVAILABLE';
}

/** Esito di un controllo registrato in `db_health_checks`. */
export type DatabaseHealthStatus = 'healthy' | 'degraded' | 'down';

/**
 * Soglia oltre la quale un check riuscito è `degraded`: su una LAN un
 * PostgreSQL sano risponde in pochi millisecondi, mezzo secondo significa che
 * qualcosa (rete, lock, carico) sta rallentando il pannello.
 */
export const DB_HEALTH_DEGRADED_MS = 500;

function healthStatus(latencyMs: number): DatabaseHealthStatus {
  return latencyMs >= DB_HEALTH_DEGRADED_MS ? 'degraded' : 'healthy';
}

/**
 * Scrittore minimo dell'audit: `pg.Pool`, `pg.PoolClient` e il client PGlite
 * dei test espongono tutti `query(sql, params)`.
 */
type AuditWriter = {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
};

/**
 * Registra un esito in `db_health_checks`. Best-effort: un audit che fallisce
 * non deve mai far fallire l'health check, quindi l'errore viene loggato e la
 * funzione risolve sempre. Senza un pool inizializzato (script isolati) non
 * c'è nulla da scrivere e la funzione esce in silenzio.
 *
 * `checked_at` resta il DEFAULT `NOW()` del database: l'istante del controllo
 * è quello del server, non quello del client che ha chiamato `/api/health`.
 */
export async function logDatabaseCheck(
  status: DatabaseHealthStatus,
  latencyMs: number,
  error?: string,
  writer?: AuditWriter | null,
): Promise<void> {
  const target = writer ?? sharedPool;
  // I fake pool dei test non hanno `query`: niente audit, nessun rumore.
  if (!target || typeof target.query !== 'function') return;

  try {
    await target.query(
      `INSERT INTO db_health_checks (status, latency_ms, error_message)
       VALUES ($1, $2, $3)`,
      [
        status,
        Math.max(0, Math.round(latencyMs)),
        error && error.length > 0 ? error.slice(0, 1_000) : null,
      ],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[DB Audit] Impossibile scrivere il log di health check:', message);
  }
}

/**
 * Verifica reale della connettività, pensata per health check e watchdog.
 *
 * - Con un `Pool` prende un client (`connect()` rispetta
 *   `connectionTimeoutMillis`, quindi pool esaurito = fallimento rapido),
 *   esegue la query di identità e lo rilascia **sempre** nel `finally`.
 * - Con un `SqlClient` (PGlite nei test, adattatori) usa quello.
 * - Non lancia mai: un database spento o un errore di rete diventano
 *   `{ healthy: false, error }`, così la rotta `/api/health` e gli script non
 *   devono gestire eccezioni.
 */
export async function checkDatabaseHealth(
  target?: Pool | SqlClient | null,
): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  const probe = target ?? sharedPool;

  if (!probe) {
    return { healthy: false, latencyMs: 0, error: 'POOL_NOT_INITIALIZED' };
  }

  try {
    if (isPgPool(probe)) {
      const client = await probe.connect();
      try {
        const { rows } = await client.query<ServerInfoRow>(SERVER_INFO_SQL);
        const latencyMs = Date.now() - startedAt;
        // Audit sulla stessa connessione già acquisita: una sola andata e
        // ritorno in più, nessun secondo `connect()` sul pool.
        await logDatabaseCheck(healthStatus(latencyMs), latencyMs, undefined, client);
        return {
          healthy: true,
          latencyMs,
          server: toServerInfo(rows[0]),
        };
      } finally {
        client.release();
      }
    }

    const latencyMs = Date.now() - startedAt;
    const server = await readServerInfo(probe);
    await logDatabaseCheck(healthStatus(latencyMs), latencyMs, undefined, probe);
    return { healthy: true, latencyMs, server };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const label = healthErrorLabel(error);
    // Con il database irraggiungibile anche l'INSERT fallirebbe dopo il
    // timeout di connessione: il tentativo resta in background, così la
    // risposta di `/api/health` non raddoppia la propria latenza.
    void logDatabaseCheck('down', latencyMs, label, probe);
    return { healthy: false, latencyMs, error: label };
  }
}

export interface ConnectionCheckOptions {
  connectionString: string;
  /** `DATABASE_URL` o `DB_*`: da dove arriva la connessione. */
  source?: string;
  /** Destinazione del log: `app.log.info` o `console.log`. */
  log?: (message: string) => void;
}

/**
 * Health check di avvio: esegue una query reale sul pool e logga una riga
 * compatta senza credenziali. L'errore originale viene rilanciato per il
 * messaggio operativo di `describeDatabaseError`.
 */
export async function checkDatabaseConnection(
  client: SqlClient,
  options: ConnectionCheckOptions,
): Promise<ServerInfo> {
  const startedAt = Date.now();
  const info = await readServerInfo(client);
  const log = options.log ?? console.log;
  const origin = options.source ? ` · config ${options.source}` : '';
  log(
    `[db] connesso · ${describeDatabaseTarget(options.connectionString)} · ` +
      `${shortVersion(info.version)}${origin} · ${Date.now() - startedAt} ms`,
  );
  return info;
}

/**
 * Repository PostgreSQL unico per auth e topologia.
 * Il pool è condiviso da tutte le richieste Fastify; le query restano SQL
 * espliciti, senza ORM, per mantenere il confine dati leggibile.
 */
export class Database {
  readonly client: SqlClient;
  /** Pool `pg` del processo; `null` quando è iniettato un client esterno. */
  readonly pool: Pool | null;

  constructor(options: DatabaseOptions) {
    if (options.client) {
      this.client = options.client;
      this.pool = null;
      return;
    }

    this.pool = getPool({
      connectionString: options.connectionString,
      max: options.max ?? POOL_DEFAULTS.max,
      idleTimeoutMillis: options.idleTimeoutMillis ?? POOL_DEFAULTS.idleTimeoutMillis,
      connectionTimeoutMillis:
        options.connectionTimeoutMillis ?? POOL_DEFAULTS.connectionTimeoutMillis,
      keepAlive: options.keepAlive ?? POOL_DEFAULTS.keepAlive,
      keepAliveInitialDelayMillis:
        options.keepAliveInitialDelayMillis ?? POOL_DEFAULTS.keepAliveInitialDelayMillis,
      ssl: options.ssl ?? false,
    });
    this.client = createSqlClient(this.pool);
  }

  async init(): Promise<void> {
    await this.client.exec(SCHEMA);
  }

  async ping(): Promise<boolean> {
    const result = await this.client.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }

  /** Identità del server per il log di avvio: nessun segreto, una sola query. */
  async serverInfo(): Promise<ServerInfo> {
    return readServerInfo(this.client);
  }

  /**
   * Health check del pool (o del client iniettato): non lancia mai, quindi la
   * rotta `/api/health` può rispondere 503 invece di far cadere il processo.
   */
  async health(): Promise<DatabaseHealth> {
    return checkDatabaseHealth(this.pool ?? this.client);
  }

  async close(): Promise<void> {
    if (this.pool) {
      // Il pool è condiviso dal processo: si chiude una sola volta.
      if (sharedPool === this.pool) await closePool();
      else await this.pool.end();
    }
    await this.client.close?.();
  }

  /**
   * Transazione su una **connessione dedicata**.
   *
   * Il repository usa un pool condiviso: `BEGIN` su una query e `COMMIT` su
   * un'altra possono finire su connessioni diverse, quindi il salvataggio bulk
   * della planimetria deve possedere la sessione per tutta la durata. Con un
   * client iniettato (PGlite nei test) la connessione è già unica.
   *
   * In caso di errore il ROLLBACK è esplicito: una connessione restituita al
   * pool in stato "idle in transaction" continuerebbe a trattenere i lock.
   */
  async withTransaction<T>(run: (client: SqlClient) => Promise<T>): Promise<T> {
    let client = this.client;
    let release: (() => void) | null = null;

    if (this.pool) {
      const pooled = await this.pool.connect();
      client = {
        async query<R>(sql: string, params?: readonly unknown[]) {
          const result = await pooled.query(sql, params ? [...params] : undefined);
          return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
        },
        async exec(sql: string) {
          await pooled.query(sql);
        },
      };
      release = () => pooled.release();
    }

    await client.exec('BEGIN');
    try {
      const result = await run(client);
      await client.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.exec('ROLLBACK');
      } catch {
        // Connessione già caduta: il pool la scarta da sé.
      }
      throw error;
    } finally {
      release?.();
    }
  }

  // ── Utenti ────────────────────────────────────────────────────────────────

  async findUserById(id: string): Promise<UserRow | undefined> {
    const { rows } = await this.client.query<UserRow>(
      'SELECT * FROM users WHERE id = $1::uuid',
      [id],
    );
    return rows[0];
  }

  async findUserByUsername(username: string): Promise<UserRow | undefined> {
    const { rows } = await this.client.query<UserRow>(
      'SELECT * FROM users WHERE username = $1',
      [username.toLowerCase()],
    );
    return rows[0];
  }

  async findKioskByDeviceId(deviceId: string): Promise<UserRow | undefined> {
    const { rows } = await this.client.query<UserRow>(
      'SELECT * FROM users WHERE kiosk_device_id = $1 AND is_kiosk_device = TRUE',
      [deviceId],
    );
    return rows[0];
  }

  async listUsers(): Promise<UserRow[]> {
    const { rows } = await this.client.query<UserRow>(
      'SELECT * FROM users ORDER BY created_at ASC',
    );
    return rows;
  }

  async insertUser(user: NewUser): Promise<void> {
    await this.client.query(
      `INSERT INTO users (
         id, username, display_name, password_hash, role, pin_hash, pin_length,
         is_kiosk_device, kiosk_device_id, allowed_rooms, active
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, TRUE)
       ON CONFLICT (username) DO NOTHING`,
      [
        user.id,
        user.username.toLowerCase(),
        user.displayName,
        user.passwordHash,
        user.role,
        user.pinHash,
        user.pinLength,
        user.isKioskDevice,
        user.kioskDeviceId,
        user.allowedRooms === null ? null : JSON.stringify(user.allowedRooms),
      ],
    );
  }

  /** Aggiornamento parziale: solo i campi presenti nell'oggetto vengono scritti. */
  async updateUser(id: string, fields: UserFields): Promise<void> {
    const columns: string[] = [];
    const values: unknown[] = [id];

    const push = (column: string, value: unknown, cast = ''): void => {
      values.push(value);
      columns.push(`${column} = $${values.length}${cast}`);
    };

    if (fields.username !== undefined) push('username', fields.username.toLowerCase());
    if (fields.displayName !== undefined) push('display_name', fields.displayName);
    if (fields.passwordHash !== undefined) push('password_hash', fields.passwordHash);
    if (fields.role !== undefined) push('role', fields.role);
    if (fields.pinHash !== undefined) push('pin_hash', fields.pinHash);
    if (fields.pinLength !== undefined) push('pin_length', fields.pinLength);
    if (fields.isKioskDevice !== undefined) push('is_kiosk_device', fields.isKioskDevice);
    if (fields.kioskDeviceId !== undefined) push('kiosk_device_id', fields.kioskDeviceId);
    if (fields.allowedRooms !== undefined) {
      push(
        'allowed_rooms',
        fields.allowedRooms === null ? null : JSON.stringify(fields.allowedRooms),
        '::jsonb',
      );
    }
    if (fields.active !== undefined) push('active', fields.active);

    if (columns.length === 0) return;
    columns.push('updated_at = now()');
    await this.client.query(
      `UPDATE users SET ${columns.join(', ')} WHERE id = $1::uuid`,
      values,
    );
  }

  async deleteUser(id: string): Promise<void> {
    await this.client.query('DELETE FROM users WHERE id = $1::uuid', [id]);
  }

  /** Admin attivi rimasti, escluso un utente: guardia anti-lockout. */
  async countActiveAdmins(excludeId?: string): Promise<number> {
    const { rows } = await this.client.query<{ count: number | string }>(
      `SELECT count(*)::int AS count FROM users
       WHERE role = 'admin' AND active = TRUE
         AND ($1::uuid IS NULL OR id <> $1::uuid)`,
      [excludeId ?? null],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async setUserActive(id: string, active: boolean): Promise<void> {
    await this.client.query(
      'UPDATE users SET active = $2, updated_at = now() WHERE id = $1::uuid',
      [id, active],
    );
  }

  async updateUserPin(id: string, pinHash: string, pinLength: 4 | 5 | 6): Promise<void> {
    await this.client.query(
      'UPDATE users SET pin_hash = $2, pin_length = $3, updated_at = now() WHERE id = $1::uuid',
      [id, pinHash, pinLength],
    );
  }

  async markAccess(id: string, label: string): Promise<void> {
    await this.client.query(
      'UPDATE users SET last_access = $2, updated_at = now() WHERE id = $1::uuid',
      [id, label],
    );
  }

  // ── Sessioni ──────────────────────────────────────────────────────────────

  async createRefreshToken(token: NewRefreshToken): Promise<void> {
    await this.client.query(
      `INSERT INTO refresh_tokens (
         id, user_id, family_id, token_hash, kind, expires_at, user_agent
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
      [
        token.id,
        token.userId,
        token.familyId,
        token.tokenHash,
        token.kind,
        new Date(token.expiresAt),
        token.userAgent,
      ],
    );
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | undefined> {
    const { rows } = await this.client.query<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    return rows[0];
  }

  async revokeRefreshToken(id: string, replacedBy: string | null = null): Promise<void> {
    await this.client.query(
      `UPDATE refresh_tokens
       SET revoked_at = now(), replaced_by = $2::uuid
       WHERE id = $1::uuid AND revoked_at IS NULL`,
      [id, replacedBy],
    );
  }

  async revokeRefreshFamily(familyId: string): Promise<void> {
    await this.client.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1::uuid AND revoked_at IS NULL',
      [familyId],
    );
  }

  async revokeUserRefreshTokens(userId: string, exceptId?: string): Promise<void> {
    if (exceptId) {
      await this.client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE user_id = $1::uuid AND id != $2::uuid AND revoked_at IS NULL`,
        [userId, exceptId],
      );
      return;
    }
    await this.client.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1::uuid AND revoked_at IS NULL',
      [userId],
    );
  }

  async purgeExpiredRefreshTokens(): Promise<void> {
    await this.client.query('DELETE FROM refresh_tokens WHERE expires_at < now()');
  }

  async lockRemaining(key: string, now = Date.now()): Promise<number> {
    const { rows } = await this.client.query<{ locked_until: Date | string | null }>(
      'SELECT locked_until FROM auth_attempts WHERE key = $1',
      [key],
    );
    const until = timestampMs(rows[0]?.locked_until);
    return until > now ? until - now : 0;
  }

  /** Registra un fallimento e applica il lockout quando si raggiunge la soglia. */
  async recordFailure(
    key: string,
    policy: AttemptPolicy,
    now = Date.now(),
  ): Promise<FailureResult> {
    const { rows } = await this.client.query<AttemptRow>(
      'SELECT * FROM auth_attempts WHERE key = $1',
      [key],
    );
    const row = rows[0];
    const windowStartedAt = timestampMs(row?.window_started_at) || now;
    const withinWindow = now - windowStartedAt <= policy.windowMs;
    let failures = withinWindow ? (row?.failures ?? 0) + 1 : 1;
    let windowStart = withinWindow ? windowStartedAt : now;
    let lockedUntil = 0;

    if (failures >= policy.maxAttempts) {
      lockedUntil = now + policy.lockoutMs;
      // Dopo il lockout si riparte con un contatore pulito.
      failures = 0;
      windowStart = now;
    }

    await this.client.query(
      `INSERT INTO auth_attempts (key, failures, window_started_at, locked_until, updated_at)
       VALUES (
         $1, $2,
         to_timestamp($3::double precision / 1000),
         CASE WHEN $4::bigint = 0 THEN NULL ELSE to_timestamp($4::double precision / 1000) END,
         to_timestamp($5::double precision / 1000)
       )
       ON CONFLICT (key) DO UPDATE SET
         failures = EXCLUDED.failures,
         window_started_at = EXCLUDED.window_started_at,
         locked_until = EXCLUDED.locked_until,
         updated_at = EXCLUDED.updated_at`,
      [key, failures, windowStart, lockedUntil, now],
    );

    return { failures, lockedUntil };
  }

  async clearFailures(key: string): Promise<void> {
    await this.client.query('DELETE FROM auth_attempts WHERE key = $1', [key]);
  }

  // ── Topologia ─────────────────────────────────────────────────────────────

  async listRooms(): Promise<RoomRow[]> {
    const { rows } = await this.client.query<RoomRow>(
      `SELECT id, name, short_label, icon, display_order, floor_id, grid_layout
       FROM rooms
       ORDER BY display_order, name`,
    );
    return rows.map((row) => ({ ...row, grid_layout: normalizeGridLayout(row.grid_layout) }));
  }

  /** Piani in ordine di lettura (piano terra, primo piano, …). */
  async listFloors(): Promise<FloorRow[]> {
    const { rows } = await this.client.query<FloorRow>(
      'SELECT id, name, level_order, icon, created_at FROM floors ORDER BY level_order, name',
    );
    return rows;
  }

  async findFloorById(id: string): Promise<FloorRow | undefined> {
    const { rows } = await this.client.query<FloorRow>(
      'SELECT id, name, level_order, icon, created_at FROM floors WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async createFloor(floor: { id: string } & FloorFields): Promise<void> {
    await this.client.query(
      'INSERT INTO floors (id, name, level_order, icon) VALUES ($1, $2, $3, $4)',
      [floor.id, floor.name, floor.level_order, floor.icon],
    );
  }

  /** Seed idempotente: un riavvio non riscrive nomi e ordine dei piani. */
  async insertFloor(floor: { id: string } & FloorFields): Promise<void> {
    await this.client.query(
      `INSERT INTO floors (id, name, level_order, icon)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [floor.id, floor.name, floor.level_order, floor.icon],
    );
  }

  async updateFloor(id: string, floor: FloorFields): Promise<void> {
    await this.client.query(
      'UPDATE floors SET name = $2, level_order = $3, icon = $4 WHERE id = $1',
      [id, floor.name, floor.level_order, floor.icon],
    );
  }

  async deleteFloor(id: string): Promise<void> {
    await this.client.query('DELETE FROM floors WHERE id = $1', [id]);
  }

  /**
   * Salvataggio bulk della planimetria: geometrie delle stanze e marker dei
   * dispositivi in **una sola transazione**. Se una riga non esiste (stanza o
   * device eliminati da un altro pannello) l'intero salvataggio viene annullato:
   * mai una pianta scritta a metà.
   */
  async updateFloorLayout(
    floorId: string,
    rooms: readonly FloorLayoutRoomUpdate[],
    devices: readonly FloorLayoutDeviceUpdate[],
  ): Promise<void> {
    await this.withTransaction(async (client) => {
      for (const room of rooms) {
        const result = await client.query(
          `UPDATE rooms
           SET floor_id = $2, grid_layout = $3::jsonb, updated_at = now()
           WHERE id = $1`,
          [
            room.id,
            room.floorId === undefined ? floorId : room.floorId,
            JSON.stringify(room.gridLayout),
          ],
        );
        if (result.rowCount === 0) {
          throw new Error(`stanza ${room.id} non trovata durante il salvataggio del layout`);
        }
      }

      for (const device of devices) {
        const result = await client.query(
          'UPDATE devices SET room_pin_position = $2::jsonb, updated_at = now() WHERE id = $1',
          [device.id, JSON.stringify(device.roomPinPosition)],
        );
        if (result.rowCount === 0) {
          throw new Error(`dispositivo ${device.id} non trovato durante il salvataggio del layout`);
        }
      }
    });
  }

  async listDevices(): Promise<DeviceRow[]> {
    const { rows } = await this.client.query<DeviceRow>(
      `SELECT id, room_id, name, type, adapter, model, state_topic, command_topic,
              availability_topic, field_map, stream_url, snapshot_url,
              stream_protocol, aspect_ratio, metadata, favorite, protected, display_order,
              room_pin_position
       FROM devices
       ORDER BY display_order, name`,
    );
    return rows.map((row) => ({
      ...row,
      room_pin_position: normalizePinPosition(row.room_pin_position),
    }));
  }

  async listScenarios(): Promise<ScenarioRow[]> {
    const { rows } = await this.client.query<ScenarioRow>(
      `SELECT id, name, description, icon, protected, actions, display_order
       FROM scenarios
       ORDER BY display_order, name`,
    );
    return rows;
  }

  async findRoomById(id: string): Promise<RoomRow | undefined> {
    const { rows } = await this.client.query<RoomRow>(
      'SELECT * FROM rooms WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async findDeviceById(id: string): Promise<DeviceRow | undefined> {
    const { rows } = await this.client.query<DeviceRow>(
      'SELECT * FROM devices WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async findScenarioById(id: string): Promise<ScenarioRow | undefined> {
    const { rows } = await this.client.query<ScenarioRow>(
      'SELECT * FROM scenarios WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async countDevicesInRoom(roomId: string): Promise<number> {
    const { rows } = await this.client.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM devices WHERE room_id = $1',
      [roomId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ── Display a parete (Kiosk Profiles) ────────────────────────────────────

  async listKioskDisplays(): Promise<KioskDisplayRow[]> {
    const { rows } = await this.client.query<KioskDisplayRow>(
      `SELECT id, name, default_room_id, dimmer_timeout_sec, dimmer_screensaver_mode,
              performance_mode, high_contrast, pin_required, screen_orientation,
              is_active, last_seen_at, created_at, updated_at
       FROM kiosk_displays
       ORDER BY is_active DESC, name`,
    );
    return rows;
  }

  async findKioskDisplay(id: string): Promise<KioskDisplayRow | undefined> {
    const { rows } = await this.client.query<KioskDisplayRow>(
      'SELECT * FROM kiosk_displays WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  /**
   * Auto-registrazione al primo avvio del pannello: crea la riga con i default
   * e riscrive `last_seen_at`. `ON CONFLICT` rende l'operazione idempotente
   * anche se due schede dello stesso tablet si presentano insieme.
   */
  async registerKioskDisplay(id: string, name: string): Promise<KioskDisplayRow> {
    const { rows } = await this.client.query<KioskDisplayRow>(
      `INSERT INTO kiosk_displays (id, name, last_seen_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
       RETURNING *`,
      [id, name],
    );
    return rows[0] as KioskDisplayRow;
  }

  /**
   * Aggiornamento completo: il chiamante ha già validato i campi, `updated_at`
   * è l'unica cosa che questa query decide da sola.
   */
  async updateKioskDisplay(
    id: string,
    fields: KioskDisplayFields,
  ): Promise<KioskDisplayRow | undefined> {
    const { rows } = await this.client.query<KioskDisplayRow>(
      `UPDATE kiosk_displays SET
         name = $2,
         default_room_id = $3,
         dimmer_timeout_sec = $4,
         dimmer_screensaver_mode = $5,
         performance_mode = $6,
         high_contrast = $7,
         pin_required = $8,
         screen_orientation = $9,
         is_active = $10,
         last_seen_at = COALESCE(last_seen_at, NOW()),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        fields.name,
        fields.default_room_id,
        fields.dimmer_timeout_sec,
        fields.dimmer_screensaver_mode,
        fields.performance_mode,
        fields.high_contrast,
        fields.pin_required,
        fields.screen_orientation,
        fields.is_active,
      ],
    );
    return rows[0];
  }

  // ── Cronotermostato ─────────────────────────────────────────────────────

  /** Tutti i dispositivi che possono ricevere un setpoint programmato. */
  async listClimateDevices(): Promise<DeviceRow[]> {
    const { rows } = await this.client.query<DeviceRow>(
      `SELECT id, room_id, name, type, adapter, model, state_topic, command_topic,
              availability_topic, field_map, stream_url, snapshot_url,
              stream_protocol, aspect_ratio, metadata, favorite, protected, display_order,
              room_pin_position
       FROM devices
       WHERE type = 'climate'
       ORDER BY display_order, name`,
    );
    return rows.map((row) => ({
      ...row,
      room_pin_position: normalizePinPosition(row.room_pin_position),
    }));
  }

  async listClimateSchedules(deviceId: string): Promise<ClimateScheduleRow[]> {
    const { rows } = await this.client.query<ClimateScheduleRow>(
      `SELECT id, device_id, day_of_week, start_time, end_time,
              target_temp, hvac_mode, is_active
       FROM climate_schedules
       WHERE device_id = $1
       ORDER BY day_of_week, start_time`,
      [deviceId],
    );
    return rows;
  }

  /**
   * Salvataggio bulk dell'intera settimana: una sola istruzione (CTE + unnest)
   * perché il client è un pool condiviso e non regge un BEGIN/COMMIT multi-query
   * su connessioni diverse. Il DELETE è nella CTE, quindi o passa tutto o nulla.
   */
  async replaceClimateSchedules(
    deviceId: string,
    schedules: readonly ClimateScheduleInput[],
  ): Promise<void> {
    await this.client.query(
      `WITH cleared AS (
         DELETE FROM climate_schedules WHERE device_id = $1
       )
       INSERT INTO climate_schedules (
         device_id, day_of_week, start_time, end_time, target_temp, hvac_mode, is_active
       )
       SELECT $1, day_of_week, start_time, end_time, target_temp, hvac_mode, is_active
       FROM unnest(
         $2::smallint[], $3::time[], $4::time[], $5::numeric[], $6::text[], $7::boolean[]
       ) AS rows(day_of_week, start_time, end_time, target_temp, hvac_mode, is_active)`,
      [
        deviceId,
        schedules.map((schedule) => schedule.dayOfWeek),
        schedules.map((schedule) => schedule.startTime),
        schedules.map((schedule) => schedule.endTime),
        schedules.map((schedule) => schedule.targetTemp),
        schedules.map((schedule) => schedule.preset),
        schedules.map((schedule) => schedule.isActive),
      ],
    );
  }

  /** Riga di stato runtime, creata alla prima lettura se assente. */
  async getClimateRuntime(deviceId: string): Promise<ClimateRuntimeRow> {
    await this.client.query(
      `INSERT INTO climate_runtime_states (device_id)
       VALUES ($1)
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId],
    );
    const { rows } = await this.client.query<ClimateRuntimeRow>(
      'SELECT * FROM climate_runtime_states WHERE device_id = $1',
      [deviceId],
    );
    const row = rows[0];
    if (!row) {
      // Impossibile con l'INSERT sopra, ma il tipo non ammette undefined.
      throw new Error(`[db] stato clima non disponibile per il device ${deviceId}`);
    }
    return row;
  }

  async listClimateRuntimes(): Promise<ClimateRuntimeRow[]> {
    const { rows } = await this.client.query<ClimateRuntimeRow>(
      'SELECT * FROM climate_runtime_states',
    );
    return rows;
  }

  /** Imposta (o sostituisce) l'override manuale di un dispositivo. */
  async setClimateOverride(deviceId: string, override: ClimateOverrideInput): Promise<void> {
    await this.client.query(
      `INSERT INTO climate_runtime_states (
         device_id, override_target_temp, override_hvac_mode, override_until, updated_at
       ) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (device_id) DO UPDATE SET
         override_target_temp = EXCLUDED.override_target_temp,
         override_hvac_mode = EXCLUDED.override_hvac_mode,
         override_until = EXCLUDED.override_until,
         updated_at = now()`,
      [deviceId, override.targetTemp, override.preset, override.until],
    );
  }

  /** Cancella l'override e la cache dell'ultimo comando (riallineamento pieno). */
  async clearClimateOverride(deviceId: string): Promise<void> {
    await this.client.query(
      `UPDATE climate_runtime_states
       SET override_target_temp = NULL, override_hvac_mode = NULL,
           override_until = NULL, updated_at = now()
       WHERE device_id = $1`,
      [deviceId],
    );
  }

  async setClimateVacation(
    deviceId: string,
    vacation: { active: boolean; until: Date | null },
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO climate_runtime_states (device_id, vacation_mode, vacation_until, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (device_id) DO UPDATE SET
         vacation_mode = EXCLUDED.vacation_mode,
         vacation_until = EXCLUDED.vacation_until,
         updated_at = now()`,
      [deviceId, vacation.active, vacation.active ? vacation.until : null],
    );
  }

  async clearClimateVacation(deviceId: string): Promise<void> {
    await this.client.query(
      `UPDATE climate_runtime_states
       SET vacation_mode = FALSE, vacation_until = NULL, updated_at = now()
       WHERE device_id = $1`,
      [deviceId],
    );
  }

  /** Cache dell'ultimo setpoint pubblicato: evita comandi identici ogni minuto. */
  async recordClimateCommand(
    deviceId: string,
    targetTemp: number | null,
    preset: ClimatePreset,
    at: Date,
  ): Promise<void> {
    await this.client.query(
      `UPDATE climate_runtime_states
       SET last_sent_target_temp = $2, last_sent_hvac_mode = $3,
           last_sent_at = $4, updated_at = now()
       WHERE device_id = $1`,
      [deviceId, targetTemp, preset, at],
    );
  }

  // ── Topologia · mutazioni (solo admin, validazione nelle route) ───────────

  async createRoom(room: NewRoom): Promise<void> {
    await this.client.query(
      `INSERT INTO rooms (id, name, short_label, icon, display_order, floor_id, grid_layout)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        room.id,
        room.name,
        room.shortLabel,
        room.icon,
        room.displayOrder,
        room.floorId ?? null,
        JSON.stringify(room.gridLayout ?? DEFAULT_GRID_LAYOUT),
      ],
    );
  }

  /**
   * Aggiornamento parziale: tocca solo le colonne presenti nella whitelist e
   * valorizzate dal payload. Restituisce `false` se la stanza non esiste più
   * (cancellata da un altro pannello tra la lettura e la scrittura).
   */
  async updateRoom(id: string, patch: RoomUpdate): Promise<boolean> {
    const { assignments, params } = buildUpdateSet(ROOM_UPDATE_COLUMNS, patch);
    if (assignments.length === 0) return true;

    const { rowCount } = await this.client.query(
      `UPDATE rooms
       SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $${params.length + 1}`,
      [...params, id],
    );
    return rowCount > 0;
  }

  /**
   * Cancellazione di una stanza in **una sola transazione**: lock della riga,
   * conteggio dei dispositivi, azione scelta dal chiamante e DELETE finale.
   *
   * - `restrict` (default): con dispositivi collegati non tocca nulla e
   *   restituisce `not_empty`, così la route risponde 409
   * - `cascade`: elimina prima i dispositivi della stanza
   * - `unassign`: li sposta nella stanza `unassigned` (il vincolo
   *   `devices.room_id NOT NULL` non permette di azzerare la colonna)
   *
   * Qualsiasi errore fa scattare il ROLLBACK in `withTransaction`: il database
   * non resta mai con dispositivi orfani o con la stanza a metà cancellata.
   */
  async deleteRoom(
    id: string,
    strategy: RoomOrphanStrategy = 'restrict',
  ): Promise<RoomDeletionResult> {
    return this.withTransaction<RoomDeletionResult>(async (client) => {
      // Il lock impedisce a un INSERT concorrente di aggiungere un dispositivo
      // dopo il conteggio ma prima del DELETE della stanza.
      const locked = await client.query<{ id: string }>(
        'SELECT id FROM rooms WHERE id = $1 FOR UPDATE',
        [id],
      );
      // `rows.length`, non `rowCount`: l'adattatore di test (PGlite) riporta
      // `affectedRows` anche per le SELECT, qui sempre 0.
      if (locked.rows.length === 0) return { status: 'not_found' };

      const counted = await client.query<{ count: number | string }>(
        'SELECT count(*)::int AS count FROM devices WHERE room_id = $1',
        [id],
      );
      const devices = Number(counted.rows[0]?.count ?? 0);

      if (devices > 0) {
        if (strategy === 'restrict') return { status: 'not_empty', devices };

        if (strategy === 'unassign') {
          // `id <> $2` protegge il caso limite: eliminare proprio la stanza di
          // raccolta non può spostarne i dispositivi dentro se stessa.
          const target = await client.query(
            'SELECT 1 FROM rooms WHERE id = $1 AND id <> $2',
            [UNASSIGNED_ROOM_ID, id],
          );
          if (target.rows.length === 0) {
            return { status: 'unassigned_room_missing', devices };
          }

          await client.query(
            'UPDATE devices SET room_id = $2, updated_at = now() WHERE room_id = $1',
            [id, UNASSIGNED_ROOM_ID],
          );
        } else {
          await client.query('DELETE FROM devices WHERE room_id = $1', [id]);
        }
      }

      await client.query('DELETE FROM rooms WHERE id = $1', [id]);
      return { status: 'deleted', devices };
    });
  }

  async createDevice(device: NewDevice): Promise<void> {
    await this.client.query(
      `INSERT INTO devices (
         id, room_id, name, type, adapter, model, state_topic, command_topic,
         availability_topic, field_map, stream_url, snapshot_url, stream_protocol,
         aspect_ratio, metadata, favorite, protected, display_order, room_pin_position
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::jsonb, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19::jsonb
       )`,
      [
        device.id,
        device.roomId,
        device.name,
        device.type,
        device.adapter,
        device.model,
        device.stateTopic,
        device.commandTopic,
        device.availabilityTopic,
        device.fieldMap === null ? null : JSON.stringify(device.fieldMap),
        device.streamUrl,
        device.snapshotUrl,
        device.streamProtocol,
        device.aspectRatio,
        JSON.stringify(device.metadata),
        device.favorite,
        device.protected,
        device.displayOrder,
        JSON.stringify(device.roomPinPosition ?? DEFAULT_PIN_POSITION),
      ],
    );
  }

  /**
   * Aggiornamento parziale di un dispositivo: la clausola SET nasce dalla
   * whitelist, i valori restano parametri posizionali. I campi assenti non
   * vengono riscritti (né azzerati), così la modifica di un nome non cancella
   * `metadata`, `fieldMap` o i campi camera impostati prima.
   */
  async updateDevice(id: string, patch: DeviceUpdate): Promise<boolean> {
    const { assignments, params } = buildUpdateSet(DEVICE_UPDATE_COLUMNS, patch);
    if (assignments.length === 0) return true;

    const { rowCount } = await this.client.query(
      `UPDATE devices
       SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $${params.length + 1}`,
      [...params, id],
    );
    return rowCount > 0;
  }

  async deleteDevice(id: string): Promise<void> {
    await this.client.query('DELETE FROM devices WHERE id = $1', [id]);
  }

  async createScenario(scenario: NewScenario): Promise<void> {
    await this.client.query(
      `INSERT INTO scenarios (id, name, description, icon, protected, actions, display_order)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        scenario.id,
        scenario.name,
        scenario.description,
        scenario.icon,
        scenario.protected,
        JSON.stringify(scenario.actions),
        scenario.displayOrder,
      ],
    );
  }

  async updateScenario(id: string, scenario: ScenarioFields): Promise<void> {
    await this.client.query(
      `UPDATE scenarios
       SET name = $2, description = $3, icon = $4, protected = $5,
           actions = $6::jsonb, display_order = $7, updated_at = now()
       WHERE id = $1`,
      [
        id,
        scenario.name,
        scenario.description,
        scenario.icon,
        scenario.protected,
        JSON.stringify(scenario.actions),
        scenario.displayOrder,
      ],
    );
  }

  async deleteScenario(id: string): Promise<void> {
    await this.client.query('DELETE FROM scenarios WHERE id = $1', [id]);
  }

  async insertRoom(room: NewRoom): Promise<void> {
    await this.client.query(
      `INSERT INTO rooms (id, name, short_label, icon, display_order, floor_id, grid_layout)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        room.id,
        room.name,
        room.shortLabel,
        room.icon,
        room.displayOrder,
        room.floorId ?? null,
        JSON.stringify(room.gridLayout ?? DEFAULT_GRID_LAYOUT),
      ],
    );
  }

  async insertDevice(device: NewDevice): Promise<void> {
    await this.client.query(
      `INSERT INTO devices (
         id, room_id, name, type, adapter, model, state_topic, command_topic,
         availability_topic, field_map, stream_url, snapshot_url, stream_protocol,
         aspect_ratio, metadata, favorite, protected, display_order, room_pin_position
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::jsonb, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19::jsonb
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        device.id,
        device.roomId,
        device.name,
        device.type,
        device.adapter,
        device.model,
        device.stateTopic,
        device.commandTopic,
        device.availabilityTopic,
        device.fieldMap === null ? null : JSON.stringify(device.fieldMap),
        device.streamUrl,
        device.snapshotUrl,
        device.streamProtocol,
        device.aspectRatio,
        JSON.stringify(device.metadata),
        device.favorite,
        device.protected,
        device.displayOrder,
        JSON.stringify(device.roomPinPosition ?? DEFAULT_PIN_POSITION),
      ],
    );
  }

  async insertScenario(scenario: NewScenario): Promise<void> {
    await this.client.query(
      `INSERT INTO scenarios (id, name, description, icon, protected, actions, display_order)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        scenario.id,
        scenario.name,
        scenario.description,
        scenario.icon,
        scenario.protected,
        JSON.stringify(scenario.actions),
        scenario.displayOrder,
      ],
    );
  }

  // ── Automazioni ──────────────────────────────────────────────────────────

  /**
   * Tutte le regole con l'esito dell'ultima esecuzione: una sola query con
   * LATERAL, così la lista del pannello non fa N+1 richieste per i badge.
   */
  async listAutomations(): Promise<AutomationWithLastLogRow[]> {
    const { rows } = await this.client.query<AutomationWithLastLogRow>(
      `SELECT a.*,
              l.triggered_at       AS last_log_at,
              l.conditions_met     AS last_log_conditions_met,
              l.execution_time_ms  AS last_log_execution_time_ms,
              l.error_message      AS last_log_error
       FROM automations a
       LEFT JOIN LATERAL (
         SELECT triggered_at, conditions_met, execution_time_ms, error_message
         FROM automation_logs
         WHERE automation_id = a.id
         ORDER BY triggered_at DESC, id DESC
         LIMIT 1
       ) l ON TRUE
       ORDER BY a.created_at ASC, a.name`,
    );
    return rows;
  }

  /**
   * Regole attive: la cache in-memory del motore (e le sottoscrizioni MQTT)
   * nasce solo da qui, quindi le regole disattivate restano visibili nel
   * pannello ma non consumano nulla.
   */
  async listActiveAutomations(): Promise<AutomationRow[]> {
    const { rows } = await this.client.query<AutomationRow>(
      `SELECT * FROM automations WHERE is_active = TRUE ORDER BY created_at ASC`,
    );
    return rows;
  }

  async findAutomationById(id: string): Promise<AutomationRow | undefined> {
    const { rows } = await this.client.query<AutomationRow>(
      'SELECT * FROM automations WHERE id = $1::uuid',
      [id],
    );
    return rows[0];
  }

  async createAutomation(rule: AutomationFields): Promise<AutomationRow | undefined> {
    const { rows } = await this.client.query<AutomationRow>(
      `INSERT INTO automations (
         name, description, is_active, trigger_type, trigger_config, conditions,
         condition_groups, actions
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
       RETURNING *`,
      [
        rule.name,
        rule.description,
        rule.isActive,
        rule.triggerType,
        JSON.stringify(rule.triggerConfig),
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.conditionGroups),
        JSON.stringify(rule.actions),
      ],
    );
    return rows[0];
  }

  /** Aggiornamento completo: la regola viene sostituita, non patchata a metà. */
  async updateAutomation(
    id: string,
    rule: AutomationFields,
  ): Promise<AutomationRow | undefined> {
    const { rows } = await this.client.query<AutomationRow>(
      `UPDATE automations SET
         name = $2, description = $3, is_active = $4, trigger_type = $5,
         trigger_config = $6::jsonb, conditions = $7::jsonb,
         condition_groups = $8::jsonb, actions = $9::jsonb,
         updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      [
        id,
        rule.name,
        rule.description,
        rule.isActive,
        rule.triggerType,
        JSON.stringify(rule.triggerConfig),
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.conditionGroups),
        JSON.stringify(rule.actions),
      ],
    );
    return rows[0];
  }

  /** Interruttore rapido del pannello: cambia solo `is_active`. */
  async setAutomationActive(id: string, active: boolean): Promise<AutomationRow | undefined> {
    const { rows } = await this.client.query<AutomationRow>(
      `UPDATE automations SET is_active = $2, updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      [id, active],
    );
    return rows[0];
  }

  async deleteAutomation(id: string): Promise<boolean> {
    const result = await this.client.query(
      'DELETE FROM automations WHERE id = $1::uuid',
      [id],
    );
    return result.rowCount > 0;
  }

  /** Contatore e timestamp dell'ultimo scatto (i log restano la cronologia). */
  async recordAutomationRun(id: string, at: Date): Promise<void> {
    await this.client.query(
      `UPDATE automations
       SET last_triggered_at = $2, execution_count = execution_count + 1, updated_at = now()
       WHERE id = $1::uuid`,
      [id, at],
    );
  }

  async insertAutomationLog(log: NewAutomationLog): Promise<AutomationLogRow | undefined> {
    const { rows } = await this.client.query<AutomationLogRow>(
      `INSERT INTO automation_logs (
         automation_id, triggered_at, trigger_source, conditions_met,
         actions_executed, execution_time_ms, error_message
       ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        log.automationId,
        log.triggeredAt ?? new Date(),
        log.triggerSource,
        log.conditionsMet,
        JSON.stringify(log.actionsExecuted),
        Math.max(0, Math.round(log.executionTimeMs)),
        log.errorMessage,
      ],
    );
    return rows[0];
  }

  /** Ultime esecuzioni di una regola, dalla più recente. */
  async listAutomationLogs(automationId: string, limit = 10): Promise<AutomationLogRow[]> {
    const { rows } = await this.client.query<AutomationLogRow>(
      `SELECT * FROM automation_logs
       WHERE automation_id = $1::uuid
       ORDER BY triggered_at DESC, id DESC
       LIMIT $2`,
      [automationId, Math.min(Math.max(Math.trunc(limit), 1), 200)],
    );
    return rows;
  }

  /** Retention: finestra temporale più limite rotativo per regola. */
  async cleanupAutomationLogs(
    retentionDays = 90,
    keepPerAutomation = 500,
  ): Promise<number> {
    const { rows } = await this.client.query<{ removed: number | string | null }>(
      'SELECT cleanup_automation_logs($1::int, $2::int) AS removed',
      [retentionDays, keepPerAutomation],
    );
    return Number(rows[0]?.removed ?? 0);
  }
}
