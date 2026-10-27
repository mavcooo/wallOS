import { afterEach, describe, expect, it, vi } from 'vitest';

import { heapUsageRatio, readHeapMemory, sampleFrameRate } from '@/lib/deviceHealth';

/** `performance` finta con (o senza) il campo non standard `memory`. */
function performanceWithMemory(memory: unknown): Performance {
  return { memory } as unknown as Performance;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readHeapMemory', () => {
  it('legge heap, totale e limite da performance.memory', () => {
    const sample = readHeapMemory(
      performanceWithMemory({
        usedJSHeapSize: 48 * 1024 * 1024,
        totalJSHeapSize: 60 * 1024 * 1024,
        jsHeapSizeLimit: 120 * 1024 * 1024,
      }),
    );

    expect(sample).toEqual({
      usedBytes: 48 * 1024 * 1024,
      totalBytes: 60 * 1024 * 1024,
      limitBytes: 120 * 1024 * 1024,
    });
    expect(heapUsageRatio(sample)).toBeCloseTo(0.4, 5);
  });

  it('restituisce null dove l’API non esiste (Safari/Firefox)', () => {
    expect(readHeapMemory(performanceWithMemory(undefined))).toBeNull();
    expect(readHeapMemory({} as Performance)).toBeNull();
    expect(heapUsageRatio(null)).toBeNull();
  });

  it('scarta campioni incoerenti invece di mostrarli come zero', () => {
    expect(
      readHeapMemory(performanceWithMemory({ usedJSHeapSize: 'molti', jsHeapSizeLimit: 120 })),
    ).toBeNull();
    expect(
      readHeapMemory(performanceWithMemory({ usedJSHeapSize: 10, jsHeapSizeLimit: 0 })),
    ).toBeNull();
    expect(
      readHeapMemory(performanceWithMemory({ usedJSHeapSize: -5, jsHeapSizeLimit: 120 })),
    ).toBeNull();
  });

  it('usa l’heap usato come totale quando il browser non lo riporta', () => {
    const sample = readHeapMemory(
      performanceWithMemory({ usedJSHeapSize: 1_024, jsHeapSizeLimit: 4_096 }),
    );

    expect(sample?.totalBytes).toBe(1_024);
  });

  it('limita la quota a 0-1 anche con campioni fuori scala', () => {
    expect(heapUsageRatio({ usedBytes: 5_000, totalBytes: 5_000, limitBytes: 1_000 })).toBe(1);
    expect(heapUsageRatio({ usedBytes: 0, totalBytes: 0, limitBytes: 1_000 })).toBe(0);
  });
});

describe('sampleFrameRate', () => {
  /** rAF finta e sincrona: avanza il clock di `stepMs` a ogni frame. */
  function stubFrames(stepMs: number): void {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      now += stepMs;
      callback(now);
      return 1;
    });
  }

  it('misura il frame rate medio della finestra', async () => {
    stubFrames(1_000 / 60);

    await expect(sampleFrameRate(1_000)).resolves.toBe(60);
  });

  it('rileva un pannello lento', async () => {
    stubFrames(1_000 / 12);

    await expect(sampleFrameRate(1_000)).resolves.toBe(12);
  });

  it('restituisce 0 dove requestAnimationFrame non esiste', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);

    await expect(sampleFrameRate(1_000)).resolves.toBe(0);
  });
});
