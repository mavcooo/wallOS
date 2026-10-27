import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeviceHealth } from '@/hooks/useDeviceHealth';
import type { HeapMemorySample } from '@/lib/deviceHealth';
import { useDeviceHealthStore } from '@/store/deviceHealthStore';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import { installFakeBattery, removeFakeBattery } from '@/test/battery';

/**
 * Il campionamento reale (heap + rAF) è testato in `src/lib/deviceHealth.test.ts`:
 * qui interessa l'orchestrazione — store condiviso, soglie, avvisi e pulizia.
 */
const health = vi.hoisted(() => ({
  sampleFrameRate: vi.fn(async (): Promise<number> => 60),
  readHeapMemory: vi.fn((): HeapMemorySample | null => null),
}));

vi.mock('@/lib/deviceHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deviceHealth')>()),
  sampleFrameRate: health.sampleFrameRate,
  readHeapMemory: health.readHeapMemory,
}));

const MEGABYTE = 1024 * 1024;

function sampleOf(usedMb: number, limitMb = 120): HeapMemorySample {
  return {
    usedBytes: usedMb * MEGABYTE,
    totalBytes: Math.min(usedMb, limitMb) * MEGABYTE,
    limitBytes: limitMb * MEGABYTE,
  };
}

function resetHealth(): void {
  useDeviceHealthStore.setState({
    supported: false,
    level: 0,
    charging: false,
    chargingTimeSec: 0,
    heap: null,
    heapRatio: null,
    fps: null,
    sampledAt: null,
  });
  useToastStore.setState({ toasts: [], history: [], alarmSilenced: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetHealth();
  health.sampleFrameRate.mockReset();
  health.sampleFrameRate.mockResolvedValue(60);
  health.readHeapMemory.mockReset();
  health.readHeapMemory.mockReturnValue(null);
  useHomeStore.getState().patchConnection({ latencyMs: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeFakeBattery();
});

describe('useDeviceHealth', () => {
  it('pubblica batteria e campione in health store condiviso', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.62;
    battery.charging = true;
    battery.chargingTime = 900;
    health.readHeapMemory.mockReturnValue(sampleOf(48));

    renderHook(() => useDeviceHealth());
    await act(async () => {});

    const state = useDeviceHealthStore.getState();
    expect(state).toMatchObject({
      supported: true,
      level: 62,
      charging: true,
      chargingTimeSec: 900,
      fps: 60,
    });
    expect(state.heap?.usedBytes).toBe(48 * MEGABYTE);
    expect(state.heapRatio).toBeCloseTo(0.4, 3);
    expect(state.sampledAt).toBeGreaterThan(0);
  });

  it('avvisa con un toast quando l’heap supera l’85% del limite', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    health.readHeapMemory.mockReturnValue(sampleOf(105));

    renderHook(() => useDeviceHealth());
    await act(async () => {});

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.priority).toBe('warning');
    expect(toasts[0]?.title).toBe('Memoria del pannello al limite');
    expect(toasts[0]?.description).toContain('88%');
    expect(warn).toHaveBeenCalledWith(
      '[health] heap JavaScript oltre la soglia',
      expect.objectContaining({ heapRatio: expect.any(Number) }),
    );
  });

  it('non ripete l’avviso di heap entro la finestra di quiete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Conteggio dei toast emessi: il toast `warning` si chiude da solo dopo 9 s,
    // quindi viaggiando nel tempo non lo si troverebbe più nello store.
    const pushed: string[] = [];
    const originalPush = useToastStore.getState().push;
    useToastStore.setState({
      push: (input) => {
        pushed.push(input.title);
        return originalPush(input);
      },
    });
    health.readHeapMemory.mockReturnValue(sampleOf(110));

    renderHook(() => useDeviceHealth({ sampleIntervalMs: 30_000 }));
    await act(async () => {});
    expect(pushed).toEqual(['Memoria del pannello al limite']);
    expect(warn).toHaveBeenCalledTimes(1);

    // Due campionamenti successivi, ancora dentro i 10 minuti di cooldown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(pushed).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(useDeviceHealthStore.getState().sampledAt).toBeGreaterThan(0);
  });

  it('registra il frame rate basso nel log senza allarmare l’utente', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    health.sampleFrameRate.mockResolvedValue(11);

    renderHook(() => useDeviceHealth());
    await act(async () => {});

    expect(useDeviceHealthStore.getState().fps).toBe(11);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[health] frame rate sotto la soglia di fluidità',
      expect.objectContaining({ fps: 11 }),
    );
  });

  it('non emette avvisi senza performance.memory (Safari/Firefox)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderHook(() => useDeviceHealth());
    await act(async () => {});

    const state = useDeviceHealthStore.getState();
    expect(state.heap).toBeNull();
    expect(state.heapRatio).toBeNull();
    expect(state.fps).toBe(60);
    expect(warn).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('ferma il campionamento allo smontaggio', async () => {
    health.readHeapMemory.mockReturnValue(sampleOf(10));
    const { unmount } = renderHook(() => useDeviceHealth({ sampleIntervalMs: 30_000 }));
    await act(async () => {});
    const sampledAt = useDeviceHealthStore.getState().sampledAt;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(useDeviceHealthStore.getState().sampledAt).toBe(sampledAt);
  });
});
