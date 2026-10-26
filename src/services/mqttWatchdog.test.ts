import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMqttWatchdog, parseHeartbeatEcho } from '@/services/mqttWatchdog';

/** Soglie ridotte: i test verificano la logica, non i tempi reali del kiosk. */
const OPTIONS = {
  heartbeatIntervalMs: 30_000,
  freezeTimeoutMs: 90_000,
  checkIntervalMs: 10_000,
  blackoutTimeoutMs: 600_000,
  reloadCountdownMs: 30_000,
  sendHeartbeat: vi.fn(),
  onFreeze: vi.fn(),
  onCountdown: vi.fn(),
  onReload: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
  for (const key of ['sendHeartbeat', 'onFreeze', 'onCountdown', 'onReload'] as const) {
    OPTIONS[key].mockClear();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseHeartbeatEcho', () => {
  it('accetta il JSON heartbeat con clientId e timestamp', () => {
    expect(parseHeartbeatEcho('{"clientId":"kiosk","timestamp":123}')).toEqual({
      timestamp: 123,
      clientId: 'kiosk',
    });
  });

  it('accetta il payload legacy (timestamp nudo)', () => {
    expect(parseHeartbeatEcho('1700000000000')).toEqual({ timestamp: 1_700_000_000_000 });
  });

  it('scarta payload vuoti, corrotti o senza timestamp valido', () => {
    expect(parseHeartbeatEcho('')).toBeNull();
    expect(parseHeartbeatEcho('   ')).toBeNull();
    expect(parseHeartbeatEcho('{"timestamp":"ciao"}')).toBeNull();
    expect(parseHeartbeatEcho('{"timestamp":0}')).toBeNull();
    expect(parseHeartbeatEcho('non-JSON')).toBeNull();
  });
});

describe('createMqttWatchdog · heartbeat', () => {
  it('pubblica il ping a ogni intervallo configurato', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    // Il primo ping parte subito, poi uno per periodo.
    expect(OPTIONS.sendHeartbeat).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(OPTIONS.sendHeartbeat).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(OPTIONS.sendHeartbeat).toHaveBeenCalledTimes(3);
    watchdog.stop();
  });

  it('nessun freeze con traffico regolare', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(10_000);
      watchdog.noteActivity();
    }
    expect(OPTIONS.onFreeze).not.toHaveBeenCalled();
    expect(watchdog.phase()).toBe('ok');
    watchdog.stop();
  });
});

describe('createMqttWatchdog · freeze 90 s', () => {
  it('dichiara il freeze oltre la soglia e lo notifica una sola volta', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    // 100 s di silenzio: la soglia di 90 s è superata.
    vi.advanceTimersByTime(100_000);
    expect(OPTIONS.onFreeze).toHaveBeenCalledTimes(1);
    expect(OPTIONS.onFreeze).toHaveBeenCalledWith(expect.any(Number));
    expect(watchdog.phase()).toBe('frozen');
    expect(watchdog.silenceMs()).toBeGreaterThanOrEqual(90_000);
    // Un secondo tick non ripete la notifica: il ritento è già in corso.
    vi.advanceTimersByTime(10_000);
    expect(OPTIONS.onFreeze).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('torna a ok non appena arriva un pacchetto valido', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    vi.advanceTimersByTime(100_000);
    expect(watchdog.phase()).toBe('frozen');

    watchdog.noteActivity();
    expect(watchdog.phase()).toBe('ok');
    expect(watchdog.silenceMs()).toBe(0);
    // Il clock riparte: serve un altro silenzio pieno per un nuovo freeze.
    vi.advanceTimersByTime(60_000);
    expect(OPTIONS.onFreeze).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40_000);
    expect(OPTIONS.onFreeze).toHaveBeenCalledTimes(2);
    watchdog.stop();
  });
});

describe('createMqttWatchdog · countdown di riavvio (10 min)', () => {
  it('avvia il countdown dopo 10 minuti di blackout e ricarica a zero', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    // 610 s: appena oltre la soglia di 600 s.
    vi.advanceTimersByTime(610_000);
    expect(OPTIONS.onCountdown).toHaveBeenCalled();
    // Un secondo dopo la soglia il countdown è sceso.
    vi.advanceTimersByTime(1_000);
    const last = OPTIONS.onCountdown.mock.calls.at(-1);
    expect(last?.[0]).toBeLessThanOrEqual(29_000);

    vi.advanceTimersByTime(30_000);
    expect(OPTIONS.onReload).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('l\'attività ripristinata ferma il countdown prima del reload', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    vi.advanceTimersByTime(610_000);
    expect(OPTIONS.onReload).not.toHaveBeenCalled();

    watchdog.noteActivity();
    vi.advanceTimersByTime(60_000);
    expect(OPTIONS.onReload).not.toHaveBeenCalled();
    expect(watchdog.phase()).toBe('ok');
    watchdog.stop();
  });

  it('"Annulla Riavvio" impedisce il reload finché non riparte il blackout', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    vi.advanceTimersByTime(620_000);
    watchdog.cancelReload();
    vi.advanceTimersByTime(120_000);
    expect(OPTIONS.onReload).not.toHaveBeenCalled();

    // Un nuovo freeze (dopo un ripristino) riarma il countdown.
    watchdog.noteActivity();
    vi.advanceTimersByTime(640_000);
    expect(OPTIONS.onReload).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('"Riprova Ora" azzera il clock e riparte il countdown', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    vi.advanceTimersByTime(620_000);
    watchdog.retryNow();
    expect(watchdog.silenceMs()).toBe(0);
    expect(watchdog.phase()).toBe('ok');

    // Il blackout prosegue: il countdown riparte dall'inizio (10 min).
    vi.advanceTimersByTime(300_000);
    expect(OPTIONS.onReload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350_000);
    expect(OPTIONS.onReload).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });
});

describe('createMqttWatchdog · stop', () => {
  it('spegne heartbeat, tick e countdown', () => {
    const watchdog = createMqttWatchdog(OPTIONS);
    vi.advanceTimersByTime(620_000);
    watchdog.stop();
    const callsAtStop = OPTIONS.sendHeartbeat.mock.calls.length;

    vi.advanceTimersByTime(120_000);
    expect(OPTIONS.sendHeartbeat.mock.calls.length).toBe(callsAtStop);
    expect(OPTIONS.onReload).not.toHaveBeenCalled();
  });
});
