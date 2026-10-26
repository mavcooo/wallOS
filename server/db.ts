import { readFileSync } from 'node:fs';

import { Pool } from 'pg';

import type {
  AttemptPolicy,
  AttemptRow,
  ClimatePreset,
  ClimateRuntimeRow,
  ClimateScheduleRow,
  DeviceRow,
  RefreshTokenRow,
  RoomRow,
  ScenarioRow,
  UserRole,
  UserRow,
} from './types.js';

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

/** Campi modificabili di una stanza (l'id è la chiave, non si riscrive). */
export interface RoomFields {
  name: string;
  shortLabel: string | null;
  icon: string;
  displayOrder: number;
}

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

/** PG restituisce Date; un driver di test può restituire la stringa ISO. */
export function timestampMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Parametri del pool condiviso, derivati dalle variabili `DB_*`/`DATABASE_URL`. */
export interface DatabasePoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  ssl: boolean;
}

/** `postgres://utente:password@host:5432/db` → `host:5432/db` (mai la password). */
export function describeDatabaseTarget(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) || '?';
    return `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
  } catch {
    return 'destinazione PostgreSQL sconosciuta';
  }
}

/** Suggerimento operativo senza esporre la password contenuta nell'URL. */
export function describeDatabaseError(error: unknown, connectionString: string): string {
  let user = 'sconosciuto';
  let database = 'sconosciuto';
  try {
    const parsed = new URL(connectionString);
    user = decodeURIComponent(parsed.username) || user;
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
        `PostgreSQL ha rifiutato la password dell'utente "${user}" su ${target}. ` +
        `Allinea DATABASE_URL/DB_PASSWORD con le credenziali reali (es. postgres://utente:password@${target}).`
      );
    case '28000':
      return `L'utente "${user}" non è autorizzato a connettersi a ${target} (pg_hba.conf).`;
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

/** Identità del server per log e health: nessun segreto, una sola query. */
export async function readServerInfo(client: SqlClient): Promise<ServerInfo> {
  const { rows } = await client.query<{
    version: string;
    database: string;
    username: string;
  }>('SELECT version() AS version, current_database() AS database, current_user AS username');
  const row = rows[0];
  return {
    version: row?.version ?? 'versione sconosciuta',
    database: row?.database ?? 'database sconosciuto',
    user: row?.username ?? 'utente sconosciuto',
  };
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
      `${shortVersion(info.version)} · utente ${info.user}${origin} · ${Date.now() - startedAt} ms`,
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
      max: options.max ?? 10,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
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

  async close(): Promise<void> {
    if (this.pool) {
      // Il pool è condiviso dal processo: si chiude una sola volta.
      if (sharedPool === this.pool) await closePool();
      else await this.pool.end();
    }
    await this.client.close?.();
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
      'SELECT id, name, short_label, icon, display_order FROM rooms ORDER BY display_order, name',
    );
    return rows;
  }

  async listDevices(): Promise<DeviceRow[]> {
    const { rows } = await this.client.query<DeviceRow>(
      `SELECT id, room_id, name, type, adapter, model, state_topic, command_topic,
              availability_topic, field_map, stream_url, snapshot_url,
              stream_protocol, aspect_ratio, metadata, favorite, protected, display_order
       FROM devices
       ORDER BY display_order, name`,
    );
    return rows;
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

  // ── Cronotermostato ─────────────────────────────────────────────────────

  /** Tutti i dispositivi che possono ricevere un setpoint programmato. */
  async listClimateDevices(): Promise<DeviceRow[]> {
    const { rows } = await this.client.query<DeviceRow>(
      `SELECT id, room_id, name, type, adapter, model, state_topic, command_topic,
              availability_topic, field_map, stream_url, snapshot_url,
              stream_protocol, aspect_ratio, metadata, favorite, protected, display_order
       FROM devices
       WHERE type = 'climate'
       ORDER BY display_order, name`,
    );
    return rows;
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
      `INSERT INTO rooms (id, name, short_label, icon, display_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [room.id, room.name, room.shortLabel, room.icon, room.displayOrder],
    );
  }

  async updateRoom(id: string, room: RoomFields): Promise<void> {
    await this.client.query(
      `UPDATE rooms
       SET name = $2, short_label = $3, icon = $4, display_order = $5, updated_at = now()
       WHERE id = $1`,
      [id, room.name, room.shortLabel, room.icon, room.displayOrder],
    );
  }

  async deleteRoom(id: string): Promise<void> {
    await this.client.query('DELETE FROM rooms WHERE id = $1', [id]);
  }

  async createDevice(device: NewDevice): Promise<void> {
    await this.client.query(
      `INSERT INTO devices (
         id, room_id, name, type, adapter, model, state_topic, command_topic,
         availability_topic, field_map, stream_url, snapshot_url, stream_protocol,
         aspect_ratio, metadata, favorite, protected, display_order
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::jsonb, $11, $12, $13, $14, $15::jsonb, $16, $17, $18
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
      ],
    );
  }

  async updateDevice(id: string, device: DeviceFields): Promise<void> {
    const hasFieldMap = device.fieldMap !== undefined;
    const hasMetadata = device.metadata !== undefined;
    await this.client.query(
      `UPDATE devices SET
         room_id = $2, name = $3, type = $4, adapter = $5, model = $6,
         state_topic = $7, command_topic = $8, availability_topic = $9,
         favorite = $10, protected = $11, display_order = $12,
         field_map = CASE WHEN $13 THEN $14::jsonb ELSE field_map END,
         stream_url = $15, snapshot_url = $16, stream_protocol = $17,
         aspect_ratio = $18,
         metadata = CASE WHEN $19 THEN $20::jsonb ELSE metadata END,
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        device.roomId,
        device.name,
        device.type,
        device.adapter,
        device.model,
        device.stateTopic,
        device.commandTopic,
        device.availabilityTopic,
        device.favorite,
        device.protected,
        device.displayOrder,
        hasFieldMap,
        device.fieldMap === undefined || device.fieldMap === null
          ? null
          : JSON.stringify(device.fieldMap),
        device.streamUrl,
        device.snapshotUrl,
        device.streamProtocol,
        device.aspectRatio,
        hasMetadata,
        device.metadata === undefined ? null : JSON.stringify(device.metadata),
      ],
    );
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
      `INSERT INTO rooms (id, name, short_label, icon, display_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [room.id, room.name, room.shortLabel, room.icon, room.displayOrder],
    );
  }

  async insertDevice(device: NewDevice): Promise<void> {
    await this.client.query(
      `INSERT INTO devices (
         id, room_id, name, type, adapter, model, state_topic, command_topic,
         availability_topic, field_map, stream_url, snapshot_url, stream_protocol,
         aspect_ratio, metadata, favorite, protected, display_order
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::jsonb, $11, $12, $13, $14, $15::jsonb, $16, $17, $18
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
}
