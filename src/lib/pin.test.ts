import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyPinAttempt,
  clearPinRateLimit,
  EMPTY_PIN_RATE_LIMIT_STATE,
  loadPinRateLimit,
  normalizeExpiredLockout,
  normalizePinRateLimitConfig,
  pinLockoutDurationMs,
  savePinRateLimit,
  verifyPinAttempt,
  type PinAttemptResponse,
  type PinRateLimitState,
} from './pin';

const NOW = 1_700_000_000_000;

const CONFIG = normalizePinRateLimitConfig({
  maxAttempts: 3,
  lockoutDurationSeconds: 30,
  maxLockoutDurationSeconds: 300,
});

function failure(state: PinRateLimitState, at = NOW) {
  return applyPinAttempt(state, { success: false }, CONFIG, at);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('configurazione del rate limit', () => {
  it('limita maxAttempts tra 3 e 5 e usa 5 come default', () => {
    expect(normalizePinRateLimitConfig().maxAttempts).toBe(5);
    expect(normalizePinRateLimitConfig({ maxAttempts: 1 }).maxAttempts).toBe(3);
    expect(normalizePinRateLimitConfig({ maxAttempts: 9 }).maxAttempts).toBe(5);
    expect(normalizePinRateLimitConfig({ maxAttempts: Number.NaN }).maxAttempts).toBe(5);
  });

  it('raddoppia la durata del blocco fino al tetto massimo', () => {
    expect(pinLockoutDurationMs(0, CONFIG)).toBe(30_000);
    expect(pinLockoutDurationMs(1, CONFIG)).toBe(60_000);
    expect(pinLockoutDurationMs(2, CONFIG)).toBe(120_000);
    expect(pinLockoutDurationMs(3, CONFIG)).toBe(240_000);
    expect(pinLockoutDurationMs(4, CONFIG)).toBe(300_000);
    expect(pinLockoutDurationMs(99, CONFIG)).toBe(300_000);
  });
});

describe('conteggio dei tentativi e lockout', () => {
  it('decrementa i tentativi e blocca al raggiungimento della soglia', () => {
    const first = failure({ ...EMPTY_PIN_RATE_LIMIT_STATE });
    expect(first.result).toMatchObject({
      success: false,
      isLocked: false,
      remainingAttempts: 2,
      lockoutRemainingSeconds: 0,
    });
    expect(first.state).toMatchObject({ failures: 1, lockoutLevel: 0, lockoutUntil: 0 });

    const second = failure(first.state);
    expect(second.result).toMatchObject({ isLocked: false, remainingAttempts: 1 });
    expect(second.state.failures).toBe(2);

    const third = failure(second.state);
    expect(third.result).toMatchObject({
      success: false,
      isLocked: true,
      remainingAttempts: 0,
      lockoutRemainingSeconds: 30,
    });
    expect(third.state).toMatchObject({
      failures: 0,
      lockoutLevel: 1,
      lockoutUntil: NOW + 30_000,
    });
  });

  it('dopo lo sblocco riparte con tentativi puliti e backoff raddoppiato', () => {
    let state: PinRateLimitState = { ...EMPTY_PIN_RATE_LIMIT_STATE };
    for (let attempt = 0; attempt < 3; attempt += 1) state = failure(state).state;
    expect(state.lockoutLevel).toBe(1);

    const afterExpiry = NOW + 30_001;
    const normalized = normalizeExpiredLockout(state, afterExpiry);
    expect(normalized).toMatchObject({ failures: 0, lockoutLevel: 1, lockoutUntil: 0 });

    // Dopo lo sblocco si hanno di nuovo `maxAttempts` tentativi, ma il blocco
    // successivo dura il doppio (60s).
    const afterFirst = failure(normalized, afterExpiry).state;
    const afterSecond = failure(afterFirst, afterExpiry).state;
    const second = failure(afterSecond, afterExpiry);

    expect(second.result.isLocked).toBe(true);
    expect(second.result.lockoutRemainingSeconds).toBe(60);
    expect(second.state.lockoutLevel).toBe(2);
  });

  it('ignora un tentativo mentre il blocco è attivo, senza estenderlo', () => {
    const locked: PinRateLimitState = {
      failures: 0,
      lockoutLevel: 1,
      lockoutUntil: NOW + 30_000,
    };

    const outcome = failure(locked, NOW + 1_000);

    expect(outcome.result).toMatchObject({
      isLocked: true,
      lockoutRemainingSeconds: 29,
    });
    expect(outcome.state).toEqual(locked);
  });

  it('rispetta un lockout del gateway più lungo di quello locale', () => {
    const outcome = applyPinAttempt(
      { ...EMPTY_PIN_RATE_LIMIT_STATE },
      { success: false, serverLockoutSeconds: 60 },
      CONFIG,
      NOW,
    );

    expect(outcome.result).toMatchObject({
      isLocked: true,
      remainingAttempts: 0,
      lockoutRemainingSeconds: 60,
    });
    expect(outcome.state.lockoutUntil).toBe(NOW + 60_000);
    expect(outcome.state.lockoutLevel).toBe(1);
  });

  it('usa il minimo tra tentativi locali e quelli comunicati dal server', () => {
    const outcome = applyPinAttempt(
      { ...EMPTY_PIN_RATE_LIMIT_STATE },
      { success: false, serverRemainingAttempts: 1 },
      CONFIG,
      NOW,
    );

    expect(outcome.result).toMatchObject({ isLocked: false, remainingAttempts: 1 });
  });

  it('azzera contatore e moltiplicatore al PIN corretto', () => {
    const outcome = applyPinAttempt(
      { failures: 2, lockoutLevel: 4, lockoutUntil: 0 },
      { success: true },
      CONFIG,
      NOW,
    );

    expect(outcome.state).toEqual({ failures: 0, lockoutLevel: 0, lockoutUntil: 0 });
    expect(outcome.result).toMatchObject({
      success: true,
      isLocked: false,
      remainingAttempts: 3,
      lockoutRemainingSeconds: 0,
    });
  });
});

describe('persistenza anti-aggiramento', () => {
  it('mantiene il blocco tra reload, isolando i profili', () => {
    savePinRateLimit('admin', { failures: 0, lockoutLevel: 1, lockoutUntil: NOW + 30_000 });

    expect(loadPinRateLimit('admin', CONFIG, NOW)).toEqual({
      failures: 0,
      lockoutLevel: 1,
      lockoutUntil: NOW + 30_000,
    });
    expect(loadPinRateLimit('ospite', CONFIG, NOW)).toEqual({ ...EMPTY_PIN_RATE_LIMIT_STATE });
    expect(loadPinRateLimit('admin', CONFIG, NOW + 30_001)).toEqual({
      failures: 0,
      lockoutLevel: 1,
      lockoutUntil: 0,
    });
  });

  it('scarta payload corrotti e limita lockout assurdi', () => {
    window.localStorage.setItem('domus.pin-rate-limit.v1:admin', '{non-json');
    expect(loadPinRateLimit('admin', CONFIG, NOW)).toEqual({ ...EMPTY_PIN_RATE_LIMIT_STATE });

    window.localStorage.setItem(
      'domus.pin-rate-limit.v1:admin',
      JSON.stringify({ version: 1, failures: 99, lockoutLevel: 99, lockoutUntil: NOW + 86_400_000 }),
    );
    const loaded = loadPinRateLimit('admin', CONFIG, NOW);
    expect(loaded.failures).toBe(2);
    expect(loaded.lockoutLevel).toBe(10);
    expect(loaded.lockoutUntil).toBe(NOW + 300_000);
  });

  it('clearPinRateLimit azzera il blocco dopo un PIN corretto', () => {
    savePinRateLimit('admin', { failures: 1, lockoutLevel: 2, lockoutUntil: NOW + 120_000 });
    clearPinRateLimit('admin');

    expect(loadPinRateLimit('admin', CONFIG, NOW)).toEqual({ ...EMPTY_PIN_RATE_LIMIT_STATE });
  });
});

describe('adattatore verso il verificatore', () => {
  const serverResponse = (overrides: Partial<PinAttemptResponse>): PinAttemptResponse => ({
    ok: false,
    locked: false,
    retryAfterMs: 0,
    remainingAttempts: 2,
    lockedUntil: null,
    ...overrides,
  });

  it('traduce la risposta del gateway in stato locale', async () => {
    const verify = vi.fn().mockResolvedValue(
      serverResponse({ locked: true, retryAfterMs: 45_000, remainingAttempts: 0, lockedUntil: NOW + 45_000 }),
    );

    const outcome = await verifyPinAttempt('0000', verify, { ...EMPTY_PIN_RATE_LIMIT_STATE }, CONFIG, NOW);

    expect(verify).toHaveBeenCalledWith('0000');
    expect(outcome.result).toMatchObject({
      success: false,
      isLocked: true,
      lockoutRemainingSeconds: 45,
    });
  });

  it('propaga il successo e azzera il livello', async () => {
    const verify = vi.fn().mockResolvedValue(serverResponse({ ok: true, remainingAttempts: 3 }));

    const outcome = await verifyPinAttempt(
      '2468',
      verify,
      { failures: 2, lockoutLevel: 3, lockoutUntil: 0 },
      CONFIG,
      NOW,
    );

    expect(outcome.result.success).toBe(true);
    expect(outcome.state).toEqual({ failures: 0, lockoutLevel: 0, lockoutUntil: 0 });
  });
});
