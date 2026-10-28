import type {
  AttemptPolicy,
  AuthConfig,
  AutomationConfig,
  MqttEventsConfig,
  PinPolicy,
} from './types.js';

const DEV_JWT_SECRET = 'dev-only-secret-change-me-domus-kiosk-auth-0001';

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = text(value)?.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function list(value: string | undefined, fallback: readonly string[]): string[] {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : [...fallback];
}

function requireInProduction(
  env: NodeJS.ProcessEnv,
  key: string,
  devFallback: string,
  issues: string[],
): string {
  const value = text(env[key]);
  if (value) return value;
  if (env.NODE_ENV === 'production') issues.push(`${key} è obbligatorio in produzione`);
  return devFallback;
}

/** Intero obbligatoriamente nel range: un valore malformato blocca l'avvio. */
function boundedInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  issues: string[],
  min: number,
  max: number,
): number {
  const raw = text(env[key]);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    issues.push(`${key} deve essere un intero tra ${min} e ${max}, ricevuto "${raw}"`);
    return fallback;
  }
  return parsed;
}

/** Booleano esplicito: `true/false/1/0`, niente fallback silenziosi. */
function strictBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
  issues: string[],
): boolean {
  const raw = text(env[key])?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  issues.push(`${key} deve essere true o false, ricevuto "${raw}"`);
  return fallback;
}

export type DatabaseUrlSource = 'DATABASE_URL' | 'DB_*';

interface ResolvedDatabase {
  /** URL effettivamente passata a `pg.Pool`. */
  url: string;
  source: DatabaseUrlSource;
  host: string;
  port: number;
  name: string;
  user: string;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePort(value: string, label: string, issues: string[]): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    issues.push(`${label} deve essere una porta TCP valida (1-65535), ricevuto "${value}"`);
    return 5432;
  }
  return parsed;
}

function parsePostgresUrl(raw: string, issues: string[]): ResolvedDatabase | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.push(
      'DATABASE_URL non è una URL valida ' +
        '(esempio: postgres://wallos_user:password@192.168.0.59:5432/wallos)',
    );
    return null;
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    issues.push(
      `DATABASE_URL deve usare lo schema postgres:// o postgresql:// (ricevuto "${parsed.protocol}")`,
    );
    return null;
  }

  const host = parsed.hostname;
  const name = decodeComponent(parsed.pathname.replace(/^\/+/, ''));
  const user = decodeComponent(parsed.username);
  const password = decodeComponent(parsed.password);

  if (!host) issues.push("DATABASE_URL senza host: indica l'IP del server PostgreSQL");
  if (!name) {
    issues.push('DATABASE_URL senza nome del database: aggiungi /wallos al termine della URL');
  }
  if (!user) {
    issues.push('DATABASE_URL senza utente: usa postgres://utente:password@host:porta/database');
  }
  if (!password) {
    issues.push('DATABASE_URL senza password: usa postgres://utente:password@host:porta/database');
  }

  const port = parsed.port ? parsePort(parsed.port, 'DATABASE_URL (porta)', issues) : 5432;
  return { url: raw, source: 'DATABASE_URL', host, port, name, user };
}

/**
 * Risolve la connessione PostgreSQL: `DATABASE_URL` ha la precedenza, le
 * variabili granulari `DB_*` sono l'alternativa (e vengono comunque validate,
 * così un refuso in `.env` non resta nascosto).
 */
function resolveDatabase(env: NodeJS.ProcessEnv, issues: string[]): ResolvedDatabase {
  const urlValue = text(env.DATABASE_URL);
  const host = text(env.DB_HOST);
  const portValue = text(env.DB_PORT);
  const name = text(env.DB_NAME);
  const user = text(env.DB_USER);
  const password = text(env.DB_PASSWORD);

  const values = {
    DB_HOST: host,
    DB_PORT: portValue,
    DB_NAME: name,
    DB_USER: user,
    DB_PASSWORD: password,
  } as const;
  const keys = Object.keys(values) as (keyof typeof values)[];
  const missing = keys.filter((key) => values[key] === undefined);

  const granularPort = portValue === undefined ? 5432 : parsePort(portValue, 'DB_PORT', issues);
  if (host !== undefined && /[\s/]/.test(host)) {
    issues.push('DB_HOST non può contenere spazi o slash: usa IP o hostname (es. 192.168.0.59)');
  }
  if (name !== undefined && !/^[A-Za-z0-9_.-]+$/.test(name)) {
    issues.push('DB_NAME può contenere solo lettere, cifre, punto, trattino e underscore');
  }

  const resolved = urlValue ? parsePostgresUrl(urlValue, issues) : null;

  if (!urlValue) {
    if (missing.length === keys.length) {
      issues.push(
        'Configurazione PostgreSQL assente: imposta DATABASE_URL oppure ' +
          'DB_HOST, DB_PORT, DB_NAME, DB_USER e DB_PASSWORD (vedi .env.example)',
      );
      return { url: '', source: 'DB_*', host: '', port: granularPort, name: '', user: '' };
    }
    if (missing.length > 0) {
      issues.push(
        `Variabili PostgreSQL mancanti quando DATABASE_URL non è impostata: ${missing.join(', ')}`,
      );
    }
  }

  if (resolved) {
    // Entrambe le fonti presenti: devono descrivere lo stesso database, altrimenti
    // una modifica a metà del .env puntare silenziosamente al posto sbagliato.
    if (missing.length === 0) {
      const mismatches: string[] = [];
      if (host !== resolved.host) mismatches.push('DB_HOST');
      if (granularPort !== resolved.port) mismatches.push('DB_PORT');
      if (name !== resolved.name) mismatches.push('DB_NAME');
      if (user !== resolved.user) mismatches.push('DB_USER');
      if (password !== decodeComponent(new URL(resolved.url).password)) {
        mismatches.push('DB_PASSWORD');
      }
      if (mismatches.length > 0) {
        issues.push(
          `DATABASE_URL non concorda con ${mismatches.join(', ')}: allinea i valori ` +
            '(la connessione usa DATABASE_URL)',
        );
      }
    }
    return resolved;
  }

  if (missing.length > 0 || !host || !name || !user || !password) {
    return { url: '', source: 'DB_*', host: host ?? '', port: granularPort, name: name ?? '', user: user ?? '' };
  }

  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url =
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${hostPart}:${granularPort}/${encodeURIComponent(name)}`;

  return { url, source: 'DB_*', host, port: granularPort, name, user };
}

/** Connessione PostgreSQL risolta, con i parametri del pool già validati. */
export interface DatabaseConfig {
  /** URL effettivamente passata a `pg.Pool`. */
  url: string;
  source: DatabaseUrlSource;
  host: string;
  port: number;
  name: string;
  user: string;
  poolMax: number;
  ssl: boolean;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
}

/**
 * Risoluzione condivisa della connessione PostgreSQL: gli issue vengono
 * accodati all'elenco del chiamante, così `loadConfig` continua a riportare
 * tutti i problemi di configurazione in un unico messaggio.
 */
function resolveDatabaseConfig(env: NodeJS.ProcessEnv, issues: string[]): DatabaseConfig {
  const database = resolveDatabase(env, issues);
  return {
    ...database,
    poolMax: boundedInteger(env, 'DATABASE_POOL_MAX', 10, issues, 1, 100),
    ssl: strictBoolean(env, 'DATABASE_SSL', false, issues),
    connectTimeoutMs: boundedInteger(env, 'DATABASE_CONNECT_TIMEOUT_MS', 5_000, issues, 1_000, 300_000),
    idleTimeoutMs: boundedInteger(env, 'DATABASE_IDLE_TIMEOUT_MS', 30_000, issues, 1_000, 3_600_000),
  };
}

/**
 * Solo la connessione PostgreSQL, con le stesse regole di `loadConfig`
 * (`DATABASE_URL` ha la precedenza sulle `DB_*`, niente credenziali
 * hardcoded). La usano gli script che non hanno bisogno di JWT, PIN e policy
 * di autenticazione — in primis le migrazioni — così host, database e
 * credenziali restano definiti in un unico punto.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const issues: string[] = [];
  const config = resolveDatabaseConfig(env, issues);
  if (issues.length > 0) {
    throw new Error(`Configurazione non valida:\n- ${issues.join('\n- ')}`);
  }
  return config;
}

/**
 * Broker MQTT usato dal server per pubblicare gli eventi di topologia
 * (`wallos/system/topology_changed`). Non è lo stesso endpoint del browser:
 * lì serve il listener WebSocket, qui il listener TCP del broker in LAN.
 *
 * - `MQTT_SERVER_URL` ha la precedenza (endpoint esplicito, es. mqtts://)
 * - altrimenti `MQTT_HOST` + `MQTT_SERVER_PORT` (default 1883)
 * - nessuno dei due → pubblicazione disabilitata (`url: null`), il server
 *   resta pienamente funzionante senza broker
 */
function resolveMqttEvents(env: NodeJS.ProcessEnv, issues: string[]): MqttEventsConfig {
  const baseTopic = (text(env.MQTT_BASE_TOPIC) ?? '').replace(/^\/+|\/+$/g, '');
  const credentials = {
    username: text(env.MQTT_USERNAME) ?? null,
    password: text(env.MQTT_PASSWORD) ?? null,
    baseTopic,
  };

  const explicit = text(env.MQTT_SERVER_URL);
  if (explicit) {
    let protocol = '';
    try {
      protocol = new URL(explicit).protocol;
    } catch {
      protocol = '';
    }
    if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(protocol)) {
      issues.push(
        `MQTT_SERVER_URL deve essere un URL mqtt://, mqtts://, ws:// o wss:// (ricevuto "${explicit}")`,
      );
      return { url: null, ...credentials };
    }
    return { url: explicit, ...credentials };
  }

  const host = text(env.MQTT_HOST);
  if (!host) return { url: null, ...credentials };
  if (/[\s/]/.test(host) && !host.includes('://')) {
    issues.push('MQTT_HOST non può contenere spazi o slash: usa IP o hostname (es. 192.168.0.10)');
  }
  const port = boundedInteger(env, 'MQTT_SERVER_PORT', 1883, issues, 1, 65535);
  return { url: `mqtt://${host}:${port}`, ...credentials };
}

/**
 * Parametri del motore di automazioni che non hanno un default sensato:
 * le coordinate servono ad alba/tramonto, il topic di presenza alla condizione
 * `user_present`. Un valore malformato è un errore di configurazione (blocca
 * l'avvio come gli altri), un parametro assente disabilita solo quella parte:
 * il server resta pienamente utilizzabile senza automazioni solari.
 */
function resolveAutomationConfig(env: NodeJS.ProcessEnv, issues: string[]): AutomationConfig {
  const coordinates: Record<string, number | null> = {};
  for (const [key, keyName, limit] of [
    ['AUTOMATION_LATITUDE', 'latitude', 90],
    ['AUTOMATION_LONGITUDE', 'longitude', 180],
  ] as const) {
    const raw = text(env[key]);
    if (raw === undefined) {
      coordinates[keyName] = null;
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
      issues.push(`${key} deve essere una coordinata tra -${limit} e ${limit}, ricevuto "${raw}"`);
      coordinates[keyName] = null;
      continue;
    }
    coordinates[keyName] = parsed;
  }

  // Mezza coppia è quasi sempre un refuso: alba/tramonto senza longitudine
  // darebbero un orario sbagliato di ore, non un'approssimazione.
  if ((coordinates['latitude'] === null) !== (coordinates['longitude'] === null)) {
    issues.push(
      'AUTOMATION_LATITUDE e AUTOMATION_LONGITUDE vanno impostate insieme: ' +
        'senza entrambe le automazioni alba/tramonto sono disabilitate',
    );
  }

  return {
    latitude: coordinates['latitude'] ?? null,
    longitude: coordinates['longitude'] ?? null,
    presenceTopic: text(env.AUTOMATION_PRESENCE_TOPIC) ?? null,
  };
}

/**
 * Legge la configurazione dall'ambiente. Il server rifiuta di partire in
 * produzione con un segreto JWT debole o credenziali di seed mancanti.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const nodeEnv = text(env.NODE_ENV) ?? 'development';
  const production = nodeEnv === 'production';
  const issues: string[] = [];

  const jwtSecret = text(env.JWT_SECRET) ?? (production ? '' : DEV_JWT_SECRET);
  if (jwtSecret.length < 32) {
    issues.push('JWT_SECRET deve essere lungo almeno 32 caratteri');
  }

  // Nessun default hardcoded: host, database e credenziali vengono solo dal .env.
  const database = resolveDatabaseConfig(env, issues);

  const adminPassword = requireInProduction(env, 'ADMIN_PASSWORD', 'admin-demo-1234', issues);
  const adminPin = requireInProduction(env, 'ADMIN_PIN', '2468', issues);
  const kioskPin = requireInProduction(env, 'KIOSK_PIN', '1234', issues);

  const pinPolicy: PinPolicy & { windowMs: number } = {
    minLength: 4,
    maxLength: 6,
    maxAttempts: integer(env.PIN_MAX_ATTEMPTS, 3),
    lockoutMs: integer(env.PIN_LOCKOUT_MS, 60_000),
    windowMs: integer(env.PIN_WINDOW_MS, 5 * 60_000),
  };

  const loginPolicy: AttemptPolicy = {
    maxAttempts: integer(env.LOGIN_MAX_ATTEMPTS, 5),
    lockoutMs: integer(env.LOGIN_LOCKOUT_MS, 5 * 60_000),
    windowMs: integer(env.LOGIN_WINDOW_MS, 15 * 60_000),
  };

  // Broker per la pubblicazione degli eventi di topologia (opzionale).
  const mqtt = resolveMqttEvents(env, issues);

  // Coordinate solari e topic di presenza del motore di automazioni.
  const automation = resolveAutomationConfig(env, issues);

  // Default `false`: il seed è un'operazione esplicita (CLI o `AUTO_SEED=true`),
  // non una tappa del bootstrap. Letto prima del controllo degli errori, così
  // un valore ambiguo (`forse`, `yes`) blocca l'avvio invece di passare come
  // spento.
  const autoSeed = strictBoolean(env, 'AUTO_SEED', false, issues);

  if (!/^\d{4,6}$/.test(adminPin)) issues.push('ADMIN_PIN deve avere 4-6 cifre');
  if (!/^\d{4,6}$/.test(kioskPin)) issues.push('KIOSK_PIN deve avere 4-6 cifre');
  if (adminPassword.length < 10) {
    issues.push('ADMIN_PASSWORD deve essere lunga almeno 10 caratteri');
  }
  if (production) {
    // I valori del template/demo non devono sopravvivere in un impianto reale.
    if (adminPin === '2468' || adminPin === '1234' || kioskPin === '1234') {
      issues.push('ADMIN_PIN/KIOSK_PIN di default non sono ammessi in produzione');
    }
    if (adminPassword === 'admin-demo-1234') {
      issues.push('ADMIN_PASSWORD demo non è ammessa in produzione');
    }
  }

  if (issues.length > 0) {
    throw new Error(`Configurazione non valida:\n- ${issues.join('\n- ')}`);
  }

  return {
    nodeEnv,
    host: text(env.AUTH_HOST) ?? '127.0.0.1',
    port: integer(env.AUTH_PORT, 8787),
    databaseUrl: database.url,
    databaseUrlSource: database.source,
    dbHost: database.host,
    dbPort: database.port,
    dbName: database.name,
    dbUser: database.user,
    dbPoolMax: database.poolMax,
    dbSsl: database.ssl,
    dbConnectTimeoutMs: database.connectTimeoutMs,
    dbIdleTimeoutMs: database.idleTimeoutMs,
    jwtSecret,
    cookieSecure: boolean(env.COOKIE_SECURE, production),
    // Solo dietro un reverse proxy fidato: altrimenti X-Forwarded-For è spoofabile.
    trustProxy: boolean(env.AUTH_TRUST_PROXY, false),
    corsOrigins: list(env.CORS_ORIGINS, ['http://localhost:3000']),
    accessTtlSec: integer(env.ACCESS_TOKEN_TTL, 15 * 60),
    refreshTtlSec: integer(env.REFRESH_TOKEN_TTL, 30 * 24 * 60 * 60),
    kioskRefreshTtlSec: integer(env.KIOSK_REFRESH_TOKEN_TTL, 90 * 24 * 60 * 60),
    elevationTtlSec: integer(env.ELEVATION_TTL, 5 * 60),
    switchTtlSec: integer(env.SWITCH_PROFILE_TTL, 10 * 60),
    bcryptRounds: integer(env.BCRYPT_ROUNDS, production ? 12 : 10),
    pinPolicy,
    loginPolicy,
    mqtt,
    automation,
    seed: {
      autoSeed,
      adminUsername: (text(env.ADMIN_USERNAME) ?? 'admin').toLowerCase(),
      adminDisplayName: text(env.ADMIN_DISPLAY_NAME) ?? 'Amministratore',
      adminPassword,
      adminPin,
      kioskUsername: (text(env.KIOSK_USERNAME) ?? 'kiosk').toLowerCase(),
      kioskDisplayName: text(env.KIOSK_DISPLAY_NAME) ?? 'Pannello Parete',
      kioskDeviceId: text(env.KIOSK_DEVICE_ID) ?? 'wall-panel-1',
      kioskPin,
    },
  };
}
