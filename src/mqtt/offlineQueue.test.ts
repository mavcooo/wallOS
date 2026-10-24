import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
