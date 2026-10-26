import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOOT_RECOVERY } from '@/config/app.config';
import { useBootRecovery } from '@/hooks/useBootRecovery';
import { useOfflineQueue, type QueuedCommand } from '@/mqtt/offlineQueue';
import { useHomeStore } from '@/store/homeStore';

const hydrating = () => useHomeStore.getState().recovery.isHydrating;

function staleCommand(timestamp: number): QueuedCommand {
  return {
    id: 'stale-1',
    deviceId: 'light-living-main',
    deviceName: 'Luce soggiorno',
    topic: 'zigbee2mqtt/living/main/set',
    payload: JSON.stringify({ state: 'OFF' }),
    timestamp,
    qos: 1,
    timeoutMs: 60_000,
    retryCount: 0,
    retain: false,
    collapseKey: 'power',
    label: 'Spegni',
    optimistic: null,
    rollback: null,
    revision: 1,
  };
}

/** Come `useMqtt`: CONNACK + timestamp di connessione nello store. */
function connect() {
  act(() => {
    useHomeStore.getState().setStatus('connected');
    useHomeStore.getState().patchConnection({ connectedAt: Date.now() });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useOfflineQueue.setState({ commands: [] });
  const { getState } = useHomeStore;
  getState().setStatus('idle');
  useHomeStore.setState({
    recovery: {
      bootedAt: Date.now(),
      isHydrating: true,
      retainedMessagesReceived: 0,
      lastRetainedAt: null,
      awaitingFirstConnect: false,
    },
    connection: { ...getState().connection, status: 'idle', connectedAt: null },
    rawLog: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('useBootRecovery · finestra di idratazione', () => {
  it('sblocca la UI dopo la quiete, mai prima del pavimento', async () => {
    renderHook(() => useBootRecovery());
    connect();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_RECOVERY.minHydrationMs - 250);
    });
    expect(hydrating()).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(hydrating()).toBe(false);

    // Diagnostica: perché e quanti retained.
    const entry = useHomeStore.getState().rawLog[0];
    expect(entry).toMatchObject({ topic: 'recovery', direction: 'system' });
    expect(entry?.payload).toContain('Idratazione completata (quiet)');
  });

  it('ogni retained sposta la quiete: chiude il tetto massimo', async () => {
    renderHook(() => useBootRecovery());
    connect();

    // Un retained al secondo: la finestra di quiete non scade mai.
    for (let second = 0; second < 11; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      act(() => {
        useHomeStore.getState().noteRetainedMessage();
      });
    }
    expect(hydrating()).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(hydrating()).toBe(false);
    expect(useHomeStore.getState().rawLog[0]?.payload).toContain('(timeout)');
  });

  it('senza broker sblocca comunque al tetto: nessun pannello congelato', async () => {
    renderHook(() => useBootRecovery());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_RECOVERY.maxHydrationMs - 100);
    });
    expect(hydrating()).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(hydrating()).toBe(false);
    expect(useHomeStore.getState().rawLog[0]?.payload).toContain('broker mai connesso');
  });
});

describe('useBootRecovery · coda offline', () => {
  it('si riarma al primo CONNACK se il tetto era scaduto offline', async () => {
    renderHook(() => useBootRecovery());

    // Nessun broker entro il tetto: la UI si sblocca per non restare congelata.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_RECOVERY.maxHydrationMs + 100);
    });
    expect(hydrating()).toBe(false);
    expect(useHomeStore.getState().recovery.awaitingFirstConnect).toBe(true);

    // Il broker arriva solo ora: la finestra riparte prima di accettare comandi.
    connect();
    expect(hydrating()).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_RECOVERY.minHydrationMs + 100);
    });
    expect(hydrating()).toBe(false);
    expect(useHomeStore.getState().recovery.awaitingFirstConnect).toBe(false);
  });

  it('scarta al mount i comandi nati prima di questo avvio', () => {
    useOfflineQueue.setState({ commands: [staleCommand(Date.now() - 60_000)] });

    renderHook(() => useBootRecovery());

    expect(useOfflineQueue.getState().commands).toHaveLength(0);
    expect(useHomeStore.getState().rawLog[0]?.payload).toContain('Scartati 1 comandi obsoleti');
  });

  it('conserva un comando creato dopo il boot', () => {
    const { bootedAt } = useHomeStore.getState().recovery;
    useOfflineQueue.setState({ commands: [staleCommand(bootedAt + 500)] });

    renderHook(() => useBootRecovery());

    expect(useOfflineQueue.getState().commands).toHaveLength(1);
  });
});
