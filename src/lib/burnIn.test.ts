import { describe, expect, it } from 'vitest';

import { BURN_IN_DEFAULTS } from '@/config/app.config';
import {
  BURN_IN_LIMITS,
  centerPoint,
  normalizeBurnInSettings,
  randomPoint,
  shiftBounds,
  subtlePoint,
} from '@/lib/burnIn';

const VIEWPORT = {
  viewportWidth: 1024,
  viewportHeight: 768,
  elementWidth: 200,
  elementHeight: 100,
  margin: 32,
};

describe('normalizeBurnInSettings', () => {
  it('senza argomenti restituisce i default', () => {
    expect(normalizeBurnInSettings()).toEqual({
      mode: BURN_IN_DEFAULTS.mode,
      shiftIntervalMs: BURN_IN_DEFAULTS.shiftIntervalMs,
      dimClockOpacity: BURN_IN_DEFAULTS.dimClockOpacity,
    });
  });

  it('richiude intervallo e opacità nei limiti', () => {
    expect(normalizeBurnInSettings({ shiftIntervalMs: 10 }).shiftIntervalMs).toBe(
      BURN_IN_LIMITS.minIntervalMs,
    );
    expect(normalizeBurnInSettings({ shiftIntervalMs: 10_000_000 }).shiftIntervalMs).toBe(
      BURN_IN_LIMITS.maxIntervalMs,
    );
    expect(normalizeBurnInSettings({ dimClockOpacity: 0 }).dimClockOpacity).toBe(
      BURN_IN_LIMITS.minClockOpacity,
    );
    expect(normalizeBurnInSettings({ dimClockOpacity: 1 }).dimClockOpacity).toBe(
      BURN_IN_LIMITS.maxClockOpacity,
    );
  });

  it('scarta mode sconosciute e valori non numerici', () => {
    const settings = normalizeBurnInSettings({
      mode: 'spinning' as never,
      shiftIntervalMs: Number.NaN,
      dimClockOpacity: Number.POSITIVE_INFINITY,
    });

    expect(settings.mode).toBe(BURN_IN_DEFAULTS.mode);
    expect(settings.shiftIntervalMs).toBe(BURN_IN_DEFAULTS.shiftIntervalMs);
    expect(settings.dimClockOpacity).toBe(BURN_IN_DEFAULTS.dimClockOpacity);
  });

  it('arrotonda intervallo e opacità', () => {
    const settings = normalizeBurnInSettings({ shiftIntervalMs: 42_000.7, dimClockOpacity: 0.333 });

    expect(settings.shiftIntervalMs).toBe(42_001);
    expect(settings.dimClockOpacity).toBe(0.33);
  });
});

describe('shiftBounds', () => {
  it('lascia spazio solo dentro viewport meno elemento e margini', () => {
    expect(shiftBounds(VIEWPORT)).toEqual({ maxX: 760, maxY: 604 });
  });

  it('non produce limiti negativi se l’elemento è più grande del viewport', () => {
    expect(
      shiftBounds({ ...VIEWPORT, elementWidth: 2000, elementHeight: 2000 }),
    ).toEqual({ maxX: 0, maxY: 0 });
  });

  it('centra l’elemento nel primo piazzamento', () => {
    expect(centerPoint(VIEWPORT)).toEqual({ x: 412, y: 334 });
  });
});

describe('randomPoint', () => {
  it('resta dentro i margini di sicurezza', () => {
    const sequence = [0, 0, 0.5, 0.5, 0.999, 0.999];
    let index = 0;
    const random = () => sequence[index++ % sequence.length] ?? 0;

    for (let i = 0; i < 3; i += 1) {
      const point = randomPoint(VIEWPORT, random);
      expect(point.x).toBeGreaterThanOrEqual(32);
      expect(point.x).toBeLessThanOrEqual(32 + 760);
      expect(point.y).toBeGreaterThanOrEqual(32);
      expect(point.y).toBeLessThanOrEqual(32 + 604);
    }
  });

  it('evita di ripetere la posizione precedente', () => {
    const stuck = randomPoint(VIEWPORT, () => 0);
    expect(stuck).toEqual({ x: 32, y: 32 });

    // Stessa sequenza: la posizione ripetuta viene scartata e si usa il centro.
    expect(randomPoint(VIEWPORT, () => 0, stuck)).toEqual(centerPoint(VIEWPORT));
  });

  it('accetta coordinate centrate quando il viewport non lascia spazio', () => {
    const tiny = { ...VIEWPORT, elementWidth: 2000, elementHeight: 2000 };
    expect(randomPoint(tiny, () => 0.7)).toEqual(centerPoint(tiny));
  });
});

describe('subtlePoint', () => {
  it('oscilla fra −ampiezza e +ampiezza', () => {
    expect(subtlePoint(3, () => 0)).toEqual({ x: -3, y: -3 });
    expect(subtlePoint(3, () => 1)).toEqual({ x: 3, y: 3 });
    expect(subtlePoint(3, () => 0.5)).toEqual({ x: 0, y: 0 });
  });

  it('rispetta ampiezze diverse (1-4 px)', () => {
    expect(subtlePoint(1, () => 1)).toEqual({ x: 1, y: 1 });
    expect(subtlePoint(4, () => 1)).toEqual({ x: 4, y: 4 });
  });
});
