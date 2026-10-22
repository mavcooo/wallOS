import type { AttemptPolicy, AuthConfig, PinPolicy } from './types.js';

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
    throw new Error(`Configurazione auth non valida:\n- ${issues.join('\n- ')}`);
  }

  return {
    nodeEnv,
    host: text(env.AUTH_HOST) ?? '127.0.0.1',
    port: integer(env.AUTH_PORT, 8787),
    dbPath: text(env.AUTH_DB_PATH) ?? './data/auth.sqlite',
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
    seed: {
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
