import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

import { BURN_IN_DEFAULTS } from '@/config/app.config';
import {
  centerPoint,
  randomPoint,
  shiftBounds,
  subtlePoint,
  type Point,
  type ShiftBoundsInput,
} from '@/lib/burnIn';
import type { BurnInMode } from '@/types/kiosk';

export interface PixelShiftOptions {
  /** `subtle-shift` = pochi px attorno all'origine; `screensaver-float` = coordinate libere. */
  mode: BurnInMode;
  intervalMs: number;
  /** Movimento solo quando true: si spegne (e torna a zero) con il risveglio. */
  enabled?: boolean;
  /** Elemento di cui misurare il bounding box per i limiti (float). */
  targetRef?: RefObject<HTMLElement | null>;
  /** Ampiezza dei micro-spostamenti, in px. */
  amplitudePx?: number;
  /** Margine di sicurezza dai bordi dello schermo. */
  marginPx?: number;
  /** Durata della transizione fra due posizioni. */
  transitionMs?: number;
  /** Iniettabile nei test per avere posizioni deterministiche. */
  random?: () => number;
}

export interface PixelShiftApi {
  /** Solo `transform`/`transition`/`will-change`: niente reflow. */
  style: CSSProperties;
  /** Posizione corrente in px, utile per diagnostica e test. */
  offset: Point;
  /** Riporta subito in posizione (senza animazione). */
  reset: () => void;
}

function clampCoordinate(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * usePixelShift
 * --------------------------------------------------------------------------
 * Sposta un elemento con la sola `transform: translate3d(...)`, quindi in
 * compositing layer: nessun repaint di layout, 60fps anche su hardware modesto.
 *
 * - `subtle-shift`: micro-oscillazione in `[-amplitude, +amplitude]` px;
 * - `screensaver-float`: coordinate pseudo-casuali calcolate su viewport meno
 *   bounding box dell'elemento e margine di sicurezza; la posizione viene
 *   ricalcolata (e richiusa nei limiti) anche al resize.
 *
 * I timer si fermano quando il documento non è visibile e vengono azzerati a
 * ogni cambio di `enabled`: al risveglio la traslazione torna a zero subito.
 */
export function usePixelShift(options: PixelShiftOptions): PixelShiftApi {
  const {
    mode,
    intervalMs,
    enabled = true,
    targetRef,
    amplitudePx = BURN_IN_DEFAULTS.subtleShiftPx,
    marginPx = BURN_IN_DEFAULTS.safeMarginPx,
    transitionMs = BURN_IN_DEFAULTS.transitionMs,
    random = Math.random,
  } = options;

  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [instant, setInstant] = useState(false);
  const randomRef = useRef(random);
  randomRef.current = random;

  const measure = useCallback((): ShiftBoundsInput => {
    const rect = targetRef?.current?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      elementWidth: rect?.width ?? 0,
      elementHeight: rect?.height ?? 0,
      margin: marginPx,
    };
  }, [marginPx, targetRef]);

  const reset = useCallback(() => {
    setInstant(true);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Posizionamento iniziale (e ritorno a zero quando il movimento si spegne).
  // `useLayoutEffect`: avviene prima del paint, nessun salto visibile.
  useLayoutEffect(() => {
    if (!enabled) {
      setInstant(true);
      setOffset({ x: 0, y: 0 });
      return;
    }
    if (mode === 'screensaver-float') {
      setInstant(true);
      setOffset(centerPoint(measure()));
    }
  }, [enabled, measure, mode]);

  const move = useCallback(() => {
    if (!enabled || document.visibilityState !== 'visible') return;
    setInstant(false);
    setOffset((current) =>
      mode === 'subtle-shift'
        ? subtlePoint(amplitudePx, randomRef.current)
        : randomPoint(measure(), randomRef.current, current),
    );
  }, [amplitudePx, enabled, measure, mode]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(move, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, move]);

  // Resize: la posizione può uscire dai nuovi limiti, va richiusa nei bordi.
  useEffect(() => {
    if (!enabled || mode !== 'screensaver-float') return;

    const onResize = () => {
      const { maxX, maxY } = shiftBounds(measure());
      setOffset((current) => ({
        x: clampCoordinate(current.x, marginPx, marginPx + maxX),
        y: clampCoordinate(current.y, marginPx, marginPx + maxY),
      }));
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled, marginPx, measure, mode]);

  return {
    offset,
    reset,
    style: {
      transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
      transition: instant ? 'none' : `transform ${transitionMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
      willChange: enabled ? 'transform' : undefined,
    },
  };
}
