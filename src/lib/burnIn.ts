import { BURN_IN_DEFAULTS } from '@/config/app.config';
import type { BurnInMode, BurnInSettings } from '@/types/kiosk';

/** Limiti entro cui le impostazioni vengono normalizzate. */
export const BURN_IN_LIMITS = {
  minIntervalMs: 5_000,
  maxIntervalMs: 15 * 60_000,
  minClockOpacity: 0.1,
  maxClockOpacity: 0.6,
} as const;

export const BURN_IN_INTERVAL_OPTIONS = [30_000, 60_000, 120_000] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isMode(value: unknown): value is BurnInMode {
  return value === 'subtle-shift' || value === 'screensaver-float';
}

/**
 * Normalizza le impostazioni: valori fuori scala (o arrivati da un persist
 * vecchio) non devono produrre timer assurdi o orologi invisibili.
 */
export function normalizeBurnInSettings(patch?: Partial<BurnInSettings>): BurnInSettings {
  const interval = Number.isFinite(patch?.shiftIntervalMs)
    ? Math.round(patch?.shiftIntervalMs as number)
    : BURN_IN_DEFAULTS.shiftIntervalMs;
  const opacity = Number.isFinite(patch?.dimClockOpacity)
    ? (patch?.dimClockOpacity as number)
    : BURN_IN_DEFAULTS.dimClockOpacity;

  return {
    mode: isMode(patch?.mode) ? patch.mode : BURN_IN_DEFAULTS.mode,
    shiftIntervalMs: clamp(interval, BURN_IN_LIMITS.minIntervalMs, BURN_IN_LIMITS.maxIntervalMs),
    dimClockOpacity: Number(
      clamp(opacity, BURN_IN_LIMITS.minClockOpacity, BURN_IN_LIMITS.maxClockOpacity).toFixed(2),
    ),
  };
}

export interface Point {
  x: number;
  y: number;
}

export interface ShiftBoundsInput {
  viewportWidth: number;
  viewportHeight: number;
  /** Dimensioni dell'elemento da spostare (bounding box, non posizione). */
  elementWidth: number;
  elementHeight: number;
  /** Margine di sicurezza dai bordi (safe area). */
  margin: number;
}

export interface ShiftBounds {
  /** Spazio di traslazione disponibile, mai negativo. */
  maxX: number;
  maxY: number;
}

/**
 * Coordinate sicure: l'elemento (posizionato a `0,0`) può traslare al massimo
 * fino a `viewport - dimensione - margine` per lato.
 */
export function shiftBounds(input: ShiftBoundsInput): ShiftBounds {
  return {
    maxX: Math.max(0, Math.round(input.viewportWidth - input.elementWidth - input.margin * 2)),
    maxY: Math.max(0, Math.round(input.viewportHeight - input.elementHeight - input.margin * 2)),
  };
}

/** Posizione centrata: primo piazzamento prima che parta la deriva. */
export function centerPoint(input: ShiftBoundsInput): Point {
  const { maxX, maxY } = shiftBounds(input);
  return {
    x: Math.round(input.margin + maxX / 2),
    y: Math.round(input.margin + maxY / 2),
  };
}

/**
 * Coordinata pseudo-casuale dentro i limiti, evitando di ripetere la stessa
 * posizione (un salto che non si vede non protegge dal burn-in).
 */
export function randomPoint(
  input: ShiftBoundsInput,
  random: () => number,
  previous?: Point,
): Point {
  const { maxX, maxY } = shiftBounds(input);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const x = Math.round(input.margin + random() * maxX);
    const y = Math.round(input.margin + random() * maxY);
    if (!previous || x !== previous.x || y !== previous.y) return { x, y };
  }

  return centerPoint(input);
}

/** Micro-spostamento simmetrico in `[-amplitude, amplitude]` px. */
export function subtlePoint(amplitude: number, random: () => number): Point {
  const offset = () => Math.round((random() * 2 - 1) * amplitude);
  return { x: offset(), y: offset() };
}
