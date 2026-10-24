import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { BURN_IN_DEFAULTS, KIOSK_DEFAULTS } from '@/config/app.config';
import { useClock } from '@/hooks/useClock';
import { usePixelShift } from '@/hooks/usePixelShift';
import { cn, formatDate, formatTime } from '@/lib/utils';
import type { BurnInMode } from '@/types/kiosk';

interface KioskDimmerOverlayProps {
  visible: boolean;
  fadeMs?: number;
  /** Opacità dell'orologio in standby (0.25-0.4 consigliata su OLED). */
  clockOpacity?: number;
  /** Strategia anti burn-in mentre l'overlay è attivo. */
  mode?: BurnInMode;
  /** Ogni quanto spostare l'orologio. */
  shiftIntervalMs?: number;
  /** Durata della transizione fra due posizioni. */
  transitionMs?: number;
}

/**
 * Overlay di standby: nero pieno, orologio a luminosità minima e in movimento.
 *
 * L'orologio è ancorato all'origine e si sposta **solo** con
 * `transform: translate3d(...)`: coordinate sicure (viewport meno bounding box
 * e margine) calcolate da `usePixelShift`, nessun reflow e nessuna animazione
 * di `top`/`left`. Il movimento non genera eventi: non risveglia il dimmer.
 *
 * Il tocco viene intercettato da useKioskDimmer in fase di capture, prima che
 * React riceva l'evento: nessun comando parte dal tap di risveglio.
 */
export function KioskDimmerOverlay({
  visible,
  fadeMs = KIOSK_DEFAULTS.dimmerFadeMs,
  clockOpacity = BURN_IN_DEFAULTS.dimClockOpacity,
  mode = BURN_IN_DEFAULTS.mode,
  shiftIntervalMs = BURN_IN_DEFAULTS.shiftIntervalMs,
  transitionMs = BURN_IN_DEFAULTS.transitionMs,
}: KioskDimmerOverlayProps) {
  const { t } = useTranslation();
  const now = useClock(1000);
  const clockRef = useRef<HTMLDivElement>(null);
  const shift = usePixelShift({
    mode,
    intervalMs: shiftIntervalMs,
    enabled: visible,
    targetRef: clockRef,
    transitionMs,
  });

  // `none` non può convivere con altre transizioni nella stessa dichiarazione.
  const transition =
    shift.style.transition === 'none'
      ? `opacity ${fadeMs}ms ease-out`
      : `${shift.style.transition}, opacity ${fadeMs}ms ease-out`;

  return (
    <div
      aria-hidden={!visible}
      data-testid="kiosk-dimmer-overlay"
      className={cn(
        'fixed inset-0 z-[80] overflow-hidden bg-black',
        'pointer-events-auto',
        visible ? 'opacity-100' : 'pointer-events-none invisible opacity-0',
      )}
      style={{
        // Solo proprietà composited. `visibility` viene ritardata della durata
        // del fade-out: a fine transizione l'overlay esce dal paint (niente
        // texture né layer composito attivo), ma durante il fade resta visibile.
        transitionProperty: 'opacity, visibility',
        transitionDuration: `${fadeMs}ms, 0ms`,
        transitionDelay: `0ms, ${visible ? '0ms' : `${fadeMs}ms`}`,
        transitionTimingFunction: 'ease-out',
        willChange: visible ? 'opacity' : 'auto',
      }}
    >
      <div
        ref={clockRef}
        data-testid="kiosk-dimmer-clock"
        className="absolute left-0 top-0 flex flex-col items-center gap-2 tabular"
        style={{
          ...shift.style,
          opacity: clockOpacity,
          transition,
          // `usePixelShift` dichiara solo transform: qui aggiungiamo opacity,
          // entrambe gestite dal compositor. A overlay spento il layer non
          // viene più promosso, quindi non occupa memoria texture.
          willChange: visible ? 'transform, opacity' : 'auto',
        }}
      >
        <span className="text-[13vw] font-extralight leading-none tracking-tight text-white">
          {formatTime(now).slice(0, 5)}
        </span>
        <span className="text-xl font-light text-white/80">{formatDate(now)}</span>
        <span className="mt-6 text-[11px] uppercase tracking-[0.35em] text-white/50">
          {t('standby.hint')}
        </span>
      </div>
    </div>
  );
}
