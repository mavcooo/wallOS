/**
 * Rate limiting locale per la verifica del PIN.
 *
 * La difesa autorevole resta il lockout del gateway (`/api/auth/verify-pin`,
 * contatori in PostgreSQL): questo modulo aggiunge un blocco lato pannello,
 * persistito in `localStorage`, così chiudere il dialog o ricaricare la pagina
 * non azzera tentativi e countdown.
 *
 * Il limitatore locale non è mai più permissivo del server: la durata effettiva
 * è `max(lockout locale, lockout comunicato dal gateway)` e, al primo PIN
 * corretto, contatore e moltiplicatore vengono azzerati.
 */

/** Risposta di verifica: locale (hash) o `/api/auth/verify-pin`. */
export interface PinAttemptResponse {
  ok: boolean;
  locked: boolean;
  retryAfterMs: number;
  remainingAttempts: number;
  lockedUntil: number | null;
}

/** Stato strutturato restituito dalla verifica (contratto stabile per la UI). */
export interface PinVerificationResult {
  success: boolean;
  remainingAttempts: number;
  isLocked: boolean;
  lockoutRemainingSeconds: number;
}

export interface PinRateLimitConfig {
  /** Tentativi errati consentiti prima del blocco (limitato a 3–5). */
  maxAttempts: number;
  /** Durata del primo blocco. */
  lockoutDurationSeconds: number;
  /** Tetto del backoff progressivo (30s → 60s → 120s → … → tetto). */
  maxLockoutDurationSeconds: number;
}

export const PIN_MAX_ATTEMPTS_MIN = 3;
export const PIN_MAX_ATTEMPTS_MAX = 5;

export const PIN_RATE_LIMIT_DEFAULTS: Readonly<PinRateLimitConfig> = {
  maxAttempts: 5,
  lockoutDurationSeconds: 30,
  maxLockoutDurationSeconds: 5 * 60,
};

/** Stato persistito: i fallimenti ripartono dopo ogni blocco scaduto. */
export interface PinRateLimitState {
  /** Tentativi errati consecutivi nella finestra corrente. */
  failures: number;
  /** Blocchi già scattati: determina il raddoppio del prossimo lockout. */
  lockoutLevel: number;
  /** Timestamp epoch ms di fine blocco; 0 = non bloccato. */
  lockoutUntil: number;
}

export const EMPTY_PIN_RATE_LIMIT_STATE: Readonly<PinRateLimitState> = {
  failures: 0,
  lockoutLevel: 0,
  lockoutUntil: 0,
};

/** Verificatore iniettabile: hash locale oppure chiamata al backend. */
export type PinVerifier = (pin: string) => Promise<PinAttemptResponse>;

const STORAGE_PREFIX = 'domus.pin-rate-limit.v1';
const STORAGE_VERSION = 1;
const MAX_LEVEL = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** Normalizza i parametri: `maxAttempts` resta sempre tra 3 e 5. */
export function normalizePinRateLimitConfig(
  overrides: Partial<PinRateLimitConfig> = {},
): PinRateLimitConfig {
  const maxAttempts = clamp(
    integer(overrides.maxAttempts, PIN_RATE_LIMIT_DEFAULTS.maxAttempts),
    PIN_MAX_ATTEMPTS_MIN,
    PIN_MAX_ATTEMPTS_MAX,
  );
  const lockoutDurationSeconds = clamp(
    integer(overrides.lockoutDurationSeconds, PIN_RATE_LIMIT_DEFAULTS.lockoutDurationSeconds),
    5,
    3600,
  );
  const maxLockoutDurationSeconds = clamp(
    integer(
      overrides.maxLockoutDurationSeconds,
      PIN_RATE_LIMIT_DEFAULTS.maxLockoutDurationSeconds,
    ),
    lockoutDurationSeconds,
    3600,
  );
  return { maxAttempts, lockoutDurationSeconds, maxLockoutDurationSeconds };
}

/** Durata del lockout per livello: 30s, 60s, 120s… fino al tetto. */
export function pinLockoutDurationMs(
  lockoutLevel: number,
  config: PinRateLimitConfig = PIN_RATE_LIMIT_DEFAULTS,
): number {
  const level = clamp(integer(lockoutLevel, 0), 0, MAX_LEVEL);
  const baseMs = config.lockoutDurationSeconds * 1000;
  return Math.min(baseMs * 2 ** level, config.maxLockoutDurationSeconds * 1000);
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(scope || 'default')}`;
}

/** `localStorage` può lanciare (Safari privato, quota, iframe): mai bloccare la UI. */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const candidate = window.localStorage;
    return typeof candidate?.getItem === 'function' ? candidate : null;
  } catch {
    return null;
  }
}

/** Un blocco scaduto azzera i fallimenti ma conserva il livello di backoff. */
export function normalizeExpiredLockout(
  state: PinRateLimitState,
  now = Date.now(),
): PinRateLimitState {
  if (state.lockoutUntil > now) return state;
  return {
    failures: state.lockoutUntil > 0 ? 0 : Math.max(0, state.failures),
    lockoutLevel: clamp(integer(state.lockoutLevel, 0), 0, MAX_LEVEL),
    lockoutUntil: 0,
  };
}

export function remainingLockoutSeconds(
  state: PinRateLimitState,
  now = Date.now(),
): number {
  return state.lockoutUntil > now ? Math.ceil((state.lockoutUntil - now) / 1000) : 0;
}

/**
 * Legge lo stato persistito per il profilo (`scope`). Un lockout nel futuro non
 * viene mai esteso oltre il tetto configurato (protezione da clock/tampering).
 */
export function loadPinRateLimit(
  scope: string,
  config: PinRateLimitConfig = PIN_RATE_LIMIT_DEFAULTS,
  now = Date.now(),
): PinRateLimitState {
  const store = storage();
  if (!store) return { ...EMPTY_PIN_RATE_LIMIT_STATE };

  try {
    const raw = store.getItem(storageKey(scope));
    if (!raw) return { ...EMPTY_PIN_RATE_LIMIT_STATE };

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== STORAGE_VERSION) return { ...EMPTY_PIN_RATE_LIMIT_STATE };

    const failures = clamp(integer(parsed.failures, 0), 0, config.maxAttempts - 1);
    const lockoutLevel = clamp(integer(parsed.lockoutLevel, 0), 0, MAX_LEVEL);
    const storedUntil = integer(parsed.lockoutUntil, 0);
    const lockoutUntil =
      storedUntil > now
        ? Math.min(storedUntil, now + config.maxLockoutDurationSeconds * 1000)
        : 0;

    return normalizeExpiredLockout({ failures, lockoutLevel, lockoutUntil }, now);
  } catch {
    return { ...EMPTY_PIN_RATE_LIMIT_STATE };
  }
}

/** Persiste fallimenti e scadenza, così un reload non aggira il blocco. */
export function savePinRateLimit(scope: string, state: PinRateLimitState): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      storageKey(scope),
      JSON.stringify({
        version: STORAGE_VERSION,
        failures: state.failures,
        lockoutLevel: state.lockoutLevel,
        lockoutUntil: state.lockoutUntil,
      }),
    );
  } catch {
    // Quota piena o storage disabilitato: il server resta comunque autorevole.
  }
}

/** PIN corretto: azzera contatore e moltiplicatore (requisito di reset). */
export function clearPinRateLimit(scope: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(storageKey(scope));
  } catch {
    // Nessun effetto sulla verifica: il gateway ha già azzerato i suoi contatori.
  }
}

export interface PinAttemptOutcome {
  success: boolean;
  /** Secondi di lockout comunicati dal gateway (0 = nessun blocco). */
  serverLockoutSeconds?: number;
  /** Tentativi residui secondo il gateway. */
  serverRemainingAttempts?: number;
}

/**
 * Applica un tentativo allo stato locale e calcola il risultato strutturato.
 * Funzione pura: il chiamante decide quando persistere con `savePinRateLimit`.
 */
export function applyPinAttempt(
  state: PinRateLimitState,
  outcome: PinAttemptOutcome,
  config: PinRateLimitConfig = PIN_RATE_LIMIT_DEFAULTS,
  now = Date.now(),
): { state: PinRateLimitState; result: PinVerificationResult } {
  const current = normalizeExpiredLockout(state, now);

  // Un tentativo durante un blocco attivo non estende né riavvia il countdown.
  if (current.lockoutUntil > now) {
    return {
      state: current,
      result: {
        success: false,
        remainingAttempts: 0,
        isLocked: true,
        lockoutRemainingSeconds: remainingLockoutSeconds(current, now),
      },
    };
  }

  if (outcome.success) {
    return {
      state: { failures: 0, lockoutLevel: 0, lockoutUntil: 0 },
      result: {
        success: true,
        remainingAttempts: config.maxAttempts,
        isLocked: false,
        lockoutRemainingSeconds: 0,
      },
    };
  }

  const failures = current.failures + 1;
  const serverLockoutSeconds = Math.max(0, Math.ceil(outcome.serverLockoutSeconds ?? 0));
  const serverRemainingAttempts = outcome.serverRemainingAttempts;

  let lockoutLevel = current.lockoutLevel;
  let lockoutUntil = 0;
  const clientLock = failures >= config.maxAttempts;

  if (clientLock) {
    lockoutUntil = now + pinLockoutDurationMs(lockoutLevel, config);
    lockoutLevel = clamp(lockoutLevel + 1, 0, MAX_LEVEL);
  }

  if (serverLockoutSeconds > 0) {
    // Il gateway è più severo (o i suoi contatori sono più avanti): allinea.
    lockoutUntil = Math.max(lockoutUntil, now + serverLockoutSeconds * 1000);
    if (!clientLock) lockoutLevel = clamp(lockoutLevel + 1, 0, MAX_LEVEL);
  }

  if (lockoutUntil > now) {
    const seconds = Math.ceil((lockoutUntil - now) / 1000);
    return {
      state: { failures: 0, lockoutLevel, lockoutUntil },
      result: {
        success: false,
        remainingAttempts: 0,
        isLocked: true,
        lockoutRemainingSeconds: seconds,
      },
    };
  }

  const localRemaining = Math.max(0, config.maxAttempts - failures);
  return {
    state: { failures, lockoutLevel, lockoutUntil: 0 },
    result: {
      success: false,
      remainingAttempts:
        serverRemainingAttempts === undefined
          ? localRemaining
          : Math.min(localRemaining, Math.max(0, serverRemainingAttempts)),
      isLocked: false,
      lockoutRemainingSeconds: 0,
    },
  };
}

/**
 * Esegue un tentativo con rate limiting, lasciando iniettare il verificatore:
 * hash locale (futuro) o `POST /api/auth/verify-pin` (backend attuale).
 */
export async function verifyPinAttempt(
  pin: string,
  verify: PinVerifier,
  state: PinRateLimitState,
  config: PinRateLimitConfig = PIN_RATE_LIMIT_DEFAULTS,
  now = Date.now(),
): Promise<{ state: PinRateLimitState; result: PinVerificationResult }> {
  const response = await verify(pin);

  const serverLockoutSeconds = response.locked
    ? Math.max(
        0,
        Math.ceil(response.retryAfterMs / 1000),
        response.lockedUntil ? Math.ceil((response.lockedUntil - now) / 1000) : 0,
      )
    : 0;

  return applyPinAttempt(
    state,
    {
      success: response.ok,
      serverLockoutSeconds,
      serverRemainingAttempts: response.remainingAttempts,
    },
    config,
    now,
  );
}
