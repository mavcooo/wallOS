import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOOT_RECOVERY, OFFLINE_QUEUE } from '@/config/app.config';
import { captureRollback } from '@/mqtt/optimistic';
import { resetBrowserStorage } from '@/test/browserEnv';
import type { QueuedCommand } from '@/mqtt/offlineQueue';
import type { DecodedState } from '@/types/device';

const LIGHT_ID = 'light-living-main';
const COMMAND_TOPIC = 'zigbee2mqtt/living/main/set';
/** TTL usato dai casi: scadenza controllata via `expireQueuedCommands`, non dal timer. */
const TTL_MS = 60_000;

beforeEach(() => {
  resetBrowserStorage();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** Moduli freschi: coda, runtime di pubblicazione e store ripartono da zero. */
async function setup() {
  vi.resetModules();
  const { useHomeStore } = await import('@/store/homeStore');
  const { SEED_TOPOLOGY, deviceOf } = await import('@/test/fixtures');
  // La topologia vive in TanStack Query: il test inietta le righe realtime
  // come farebbe TopologyGate dopo il bootstrap.
  useHomeStore.getState().syncDeviceStates(SEED_TOPOLOGY.devices);
  // Safe boot concluso: qui si prova la coda operativa. I casi che vogliono
  // l'idratazione in corso la riattivano esplicitamente.
  useHomeStore.getState().finishHydration();
  const queue = await import('@/mqtt/offlineQueue');
  const { useToastStore } = await import('@/store/toastStore');
  return {
    useHomeStore,
    useToastStore,
    lightName: deviceOf(LIGHT_ID, 'light').name,
    ...queue,
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

/** La coda lavora sul runtime del device, non sui metadati. */
function lightOf(ctx: Context) {
  const device = ctx.useHomeStore.getState().deviceStates[LIGHT_ID];
  if (!device || device.kind !== 'light') throw new Error(`device ${LIGHT_ID} non trovato`);
  return device;
}

function brightnessOf(ctx: Context): number | undefined {
  return lightOf(ctx).state.brightness;
}

/** Come `sendAction`: cattura il rollback, applica la patch, accoda il comando. */
function enqueueBrightness(ctx: Context, brightness: number, timeoutMs = TTL_MS) {
  const device = lightOf(ctx);
  const optimistic: DecodedState = { kind: 'light', state: { brightness } };
  const rollback = captureRollback(device, optimistic);
  ctx.useHomeStore.getState().applyOptimistic(LIGHT_ID, optimistic);

  return ctx.useOfflineQueue.getState().enqueue({
    deviceId: LIGHT_ID,
    deviceName: ctx.lightName,
    topic: COMMAND_TOPIC,
    payload: JSON.stringify({ brightness }),
    qos: 1,
    timeoutMs,
    collapseKey: 'brightness',
    label: `Luminosità ${brightness}%`,
    optimistic,
    rollback,
  });
}

function lastToast(ctx: Context) {
  return ctx.useToastStore.getState().toasts.at(-1);
}

/** Comando autonomo su un device arbitrario: serve ai casi di capacità. */
function enqueueDevice(ctx: Context, id: string) {
  return ctx.useOfflineQueue.getState().enqueue({
    deviceId: id,
    deviceName: `Device ${id}`,
    topic: `test/${id}/set`,
    payload: JSON.stringify({ power: true }),
    qos: 1,
    timeoutMs: TTL_MS,
    collapseKey: 'power',
    label: 'Accensione',
    optimistic: null,
    rollback: null,
  });
}

/** Contenuto effettivo di `localStorage`, non solo lo stato in memoria. */
function persistedCommands(): QueuedCommand[] {
  const raw = window.localStorage.getItem('wallos_offline_queue');
  if (!raw) return [];
  return (JSON.parse(raw) as { state: { commands: QueuedCommand[] } }).state.commands;
}

describe('coda offline: TTL', () => {
  it('un comando ancora valido resta in coda e la UI mostra il valore ottimistico', async () => {
    const ctx = await setup();
    const original = brightnessOf(ctx);
    const command = enqueueBrightness(ctx, 45);

    expect(brightnessOf(ctx)).toBe(45);

    expect(ctx.expireQueuedCommands(command.timestamp + TTL_MS - 1)).toBe(0);
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(1);
    expect(brightnessOf(ctx)).toBe(45);
    expect(ctx.useToastStore.getState().toasts).toHaveLength(0);
    expect(original).toBeDefined();
  });

  it('allo scadere del TTL rimuove il comando, ripristina il valore reale e avvisa', async () => {
    const ctx = await setup();
    const original = brightnessOf(ctx);
    const command = enqueueBrightness(ctx, 45);

    expect(ctx.expireQueuedCommands(command.timestamp + TTL_MS)).toBe(1);

    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);
    expect(brightnessOf(ctx)).toBe(original);
    expect(lastToast(ctx)).toMatchObject({ title: 'Comando scaduto', tone: 'info' });
    expect(lastToast(ctx)?.description).toContain(ctx.lightName);
  });

  it('il rollback non sovrascrive un valore arrivato nel frattempo dal broker', async () => {
    const ctx = await setup();
    const command = enqueueBrightness(ctx, 45);

    // `stat` reale del broker con un valore diverso da quello ottimistico.
    ctx.useHomeStore.getState().applyOptimistic(LIGHT_ID, { kind: 'light', state: { brightness: 88 } });

    expect(ctx.expireQueuedCommands(command.timestamp + TTL_MS)).toBe(1);

    expect(brightnessOf(ctx)).toBe(88);
    // Il comando esce comunque dalla coda e l'utente sa cosa è successo.
    expect(lastToast(ctx)).toMatchObject({ title: 'Comando scaduto' });
  });
});

describe('coda offline: collasso e revisioni', () => {
  it('lo stesso campo collassa in un solo comando e conserva il rollback originale', async () => {
    const ctx = await setup();
    const original = brightnessOf(ctx);

    const first = enqueueBrightness(ctx, 30);
    const second = enqueueBrightness(ctx, 70);

    const commands = ctx.useOfflineQueue.getState().commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: first.id,
      payload: JSON.stringify({ brightness: 70 }),
      revision: 2,
    });
    expect(commands[0]?.rollback).toEqual(first.rollback);
    expect(commands[0]?.rollback).toEqual({ kind: 'light', state: { brightness: original } });
    expect(brightnessOf(ctx)).toBe(70);
    expect(second.id).toBe(first.id);
  });

  it('un ACK della revisione precedente non tocca il comando collassato', async () => {
    const ctx = await setup();

    const first = enqueueBrightness(ctx, 30);
    enqueueBrightness(ctx, 70);

    expect(ctx.useOfflineQueue.getState().remove(first.id, 1)).toBe(false);
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(1);

    expect(ctx.useOfflineQueue.getState().remove(first.id, 2)).toBe(true);
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);
  });
});

describe('coda offline: purge dei comandi pre-blackout', () => {
  it('scarta i comandi nati in una sessione precedente e non li trasmette', async () => {
    const ctx = await setup();
    enqueueBrightness(ctx, 40);
    const command = ctx.useOfflineQueue.getState().commands[0]!;
    // Il pannello è ripartito dopo il comando: blackout o refresh forzato.
    const bootedAt = command.timestamp + 1_000;

    // Anche con il runtime connesso, dopo il purge non parte nulla.
    const publish = vi.fn(async () => true);
    ctx.installQueueRuntime({ isConnected: () => true, publish });

    const result = ctx.purgeStaleCommandsOnBoot({ bootedAt, now: bootedAt + 10 });

    expect(result).toMatchObject({ discarded: 1, previousSession: 1, tooOld: 0 });
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);

    await ctx.flushOfflineQueue();
    expect(publish).not.toHaveBeenCalled();
  });

  it('conserva i comandi della sessione corrente', async () => {
    const ctx = await setup();
    enqueueBrightness(ctx, 40);
    const command = ctx.useOfflineQueue.getState().commands[0]!;

    const result = ctx.purgeStaleCommandsOnBoot({
      bootedAt: command.timestamp - 1_000,
      now: command.timestamp + 1_000,
    });

    expect(result.discarded).toBe(0);
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(1);
  });

  it('scarta anche un comando troppo vecchio con lo stesso timestamp di boot', async () => {
    const ctx = await setup();
    enqueueBrightness(ctx, 40);
    const command = ctx.useOfflineQueue.getState().commands[0]!;

    const result = ctx.purgeStaleCommandsOnBoot({
      bootedAt: command.timestamp - 1_000,
      now: command.timestamp + BOOT_RECOVERY.maxCommandTtlMs + 1,
    });

    expect(result).toMatchObject({ discarded: 1, previousSession: 0, tooOld: 1 });
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);
  });

  it('registra il purge nel buffer diagnostico del pannello', async () => {
    const ctx = await setup();
    enqueueBrightness(ctx, 40);
    const command = ctx.useOfflineQueue.getState().commands[0]!;

    ctx.purgeStaleCommandsOnBoot({ bootedAt: command.timestamp + 1_000, now: command.timestamp + 2_000 });

    const entry = ctx.useHomeStore.getState().rawLog[0];
    expect(entry).toMatchObject({ direction: 'system', topic: 'recovery' });
    expect(entry?.payload).toContain('Scartati 1 comandi obsoleti');
  });
});

describe('coda offline: Safe Boot', () => {
  it('resta in pausa durante l\'idratazione, anche con runtime connesso', async () => {
    const ctx = await setup();
    enqueueBrightness(ctx, 40);
    ctx.useHomeStore.setState({
      recovery: { ...ctx.useHomeStore.getState().recovery, isHydrating: true },
    });
    const publish = vi.fn(async () => true);
    ctx.installQueueRuntime({ isConnected: () => true, publish });

    await ctx.flushOfflineQueue();

    expect(publish).not.toHaveBeenCalled();
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(1);

    // Fine idratazione: la coda riprende normalmente.
    ctx.useHomeStore.getState().finishHydration();
    const result = await ctx.flushOfflineQueue();
    expect(result.sent).toBe(1);
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);
  });
});

describe('coda offline: flush, retry e rollback', () => {
  it('senza connessione il flush lascia comandi e tentativi invariati', async () => {
    const ctx = await setup();
    const command = enqueueBrightness(ctx, 45);
    const publish = vi.fn(async () => true);
    ctx.installQueueRuntime({ isConnected: () => false, publish });

    await expect(ctx.flushOfflineQueue()).resolves.toEqual({ sent: 0, expired: 0, failed: 0 });

    expect(publish).not.toHaveBeenCalled();
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(1);
    expect(ctx.useOfflineQueue.getState().commands[0]?.retryCount).toBe(0);
    expect(brightnessOf(ctx)).toBe(45);
    expect(command.id).toBe(ctx.useOfflineQueue.getState().commands[0]?.id);
  });

  it('il publish confermato svuota la coda senza rollback', async () => {
    const ctx = await setup();
    enqueueBrightness(ctx, 45);
    const publish = vi.fn(async (_command: QueuedCommand) => true);
    ctx.installQueueRuntime({ isConnected: () => true, publish });

    const result = await ctx.flushOfflineQueue();

    expect(result).toEqual({ sent: 1, expired: 0, failed: 0 });
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);
    expect(brightnessOf(ctx)).toBe(45);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      topic: COMMAND_TOPIC,
      payload: JSON.stringify({ brightness: 45 }),
      qos: 1,
    });
    expect(ctx.useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dopo gli ultimi tentativi falliti fa rollback e segnala l’errore', async () => {
    vi.useFakeTimers();
    const ctx = await setup();
    const original = brightnessOf(ctx);
    enqueueBrightness(ctx, 45);
    const publish = vi.fn(async () => false);
    ctx.installQueueRuntime({ isConnected: () => true, publish });

    // 1° tentativo: nessun rollback, si riprogramma il retry.
    await ctx.flushOfflineQueue();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(ctx.useOfflineQueue.getState().commands[0]?.retryCount).toBe(1);
    expect(brightnessOf(ctx)).toBe(45);

    // 2° tentativo (backoff 500 ms): consuma l'ultimo retry disponibile.
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(ctx.useOfflineQueue.getState().commands[0]?.retryCount).toBe(2);
    expect(brightnessOf(ctx)).toBe(45);

    // 3° tentativo (backoff 1000 ms): tentativi esauriti → rollback.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);
    expect(brightnessOf(ctx)).toBe(original);
    expect(lastToast(ctx)).toMatchObject({ title: 'Comando non sincronizzato', tone: 'error' });
  });
});

describe('coda offline: limite FIFO', () => {
  it('non supera MAX_QUEUE_SIZE e scarta i comandi più vecchi anche su storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ctx = await setup();
      for (let index = 0; index < ctx.MAX_QUEUE_SIZE + 5; index += 1) {
        enqueueDevice(ctx, `device-${index}`);
      }

      const commands = ctx.useOfflineQueue.getState().commands;
      expect(commands).toHaveLength(ctx.MAX_QUEUE_SIZE);
      expect(commands[0]?.deviceId).toBe('device-5');
      expect(commands.at(-1)?.deviceId).toBe(`device-${ctx.MAX_QUEUE_SIZE + 4}`);
      // La copia persistita è limitata allo stesso modo: nessuna crescita
      // illimitata in localStorage durante un offline prolungato.
      expect(persistedCommands()).toHaveLength(ctx.MAX_QUEUE_SIZE);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Coda satura'));
    } finally {
      warn.mockRestore();
    }
  });

  it('un comando collassato non consuma capacità aggiuntiva a coda piena', async () => {
    const ctx = await setup();
    for (let index = 0; index < ctx.MAX_QUEUE_SIZE; index += 1) {
      enqueueDevice(ctx, `device-${index}`);
    }

    enqueueDevice(ctx, `device-${ctx.MAX_QUEUE_SIZE - 1}`);

    const commands = ctx.useOfflineQueue.getState().commands;
    expect(commands).toHaveLength(ctx.MAX_QUEUE_SIZE);
    expect(commands[0]?.deviceId).toBe('device-0');
    expect(persistedCommands()).toHaveLength(ctx.MAX_QUEUE_SIZE);
  });
});

describe('coda offline: collasso dei valori intermedi', () => {
  it('cinque variazioni dello stesso slider lasciano solo l’ultimo valore', async () => {
    const ctx = await setup();
    const original = brightnessOf(ctx);

    for (const brightness of [20, 35, 50, 30, 55]) {
      enqueueBrightness(ctx, brightness);
    }

    const commands = ctx.useOfflineQueue.getState().commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      deviceId: LIGHT_ID,
      payload: JSON.stringify({ brightness: 55 }),
      revision: 5,
    });
    expect(commands[0]?.rollback).toEqual({ kind: 'light', state: { brightness: original } });
    expect(brightnessOf(ctx)).toBe(55);
    expect(persistedCommands()).toHaveLength(1);
  });

  it('due campi diversi dello stesso device restano due comandi distinti', async () => {
    const ctx = await setup();
    enqueueBrightness(ctx, 40);
    enqueueDevice(ctx, LIGHT_ID);

    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(2);
  });
});

describe('coda offline: flush cadenzato', () => {
  it('distanzia i publish di flushGapMs (50 ms) senza raffica', async () => {
    vi.useFakeTimers();
    const ctx = await setup();
    for (const id of ['device-a', 'device-b', 'device-c']) enqueueDevice(ctx, id);

    const sentAt: number[] = [];
    const publish = vi.fn(async (_command: QueuedCommand) => {
      sentAt.push(Date.now());
      return true;
    });
    ctx.installQueueRuntime({ isConnected: () => true, publish });

    const done = ctx.flushOfflineQueue();

    // Primo comando subito, senza attesa.
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);

    // Il secondo non parte prima della pausa configurata.
    await vi.advanceTimersByTimeAsync(OFFLINE_QUEUE.flushGapMs - 1);
    expect(publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(OFFLINE_QUEUE.flushGapMs);
    expect(publish).toHaveBeenCalledTimes(3);

    // L'ultimo intervallo atteso è quello conclusivo del flush.
    await vi.advanceTimersByTimeAsync(OFFLINE_QUEUE.flushGapMs);
    await expect(done).resolves.toEqual({ sent: 3, expired: 0, failed: 0 });

    expect(OFFLINE_QUEUE.flushGapMs).toBe(50);
    expect(sentAt[1]! - sentAt[0]!).toBe(OFFLINE_QUEUE.flushGapMs);
    expect(sentAt[2]! - sentAt[1]!).toBe(OFFLINE_QUEUE.flushGapMs);
    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(0);
  });

  it('se la connessione cade durante il flush i comandi residui restano persistiti', async () => {
    const ctx = await setup();
    for (const id of ['device-a', 'device-b', 'device-c']) enqueueDevice(ctx, id);

    let connected = true;
    const publish = vi.fn(async (_command: QueuedCommand) => {
      // Il broker chiude la socket dopo il primo PUBACK.
      connected = false;
      return true;
    });
    ctx.installQueueRuntime({ isConnected: () => connected, publish });

    const result = await ctx.flushOfflineQueue();

    expect(result.sent).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    const residual = ['device-b', 'device-c'];
    expect(ctx.useOfflineQueue.getState().commands.map((command) => command.deviceId)).toEqual(
      residual,
    );
    expect(persistedCommands().map((command) => command.deviceId)).toEqual(residual);
  });
});

describe('coda offline: storage non disponibile', () => {
  it('una scrittura rifiutata (QuotaExceededError) non blocca l’accodamento', async () => {
    const ctx = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nativeSetItem = Storage.prototype.setItem;
    // Solo la coda rifiuta la scrittura: lo store delle preferenze resta sano.
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === 'wallos_offline_queue') {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        nativeSetItem.call(this, key, value);
      });

    try {
      expect(() => enqueueBrightness(ctx, 42)).not.toThrow();
    } finally {
      setItem.mockRestore();
      warn.mockRestore();
    }

    expect(ctx.useOfflineQueue.getState().commands).toHaveLength(1);
    expect(brightnessOf(ctx)).toBe(42);
  });
});

