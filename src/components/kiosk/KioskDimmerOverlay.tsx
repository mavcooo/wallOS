import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { BURN_IN_DEFAULTS, KIOSK_DEFAULTS } from '@/config/app.config';
import { useClock } from '@/hooks/useClock';
import { usePixelShift } from '@/hooks/usePixelShift';
import { cn, formatDate, formatTime } from '@/lib/utils';
import type { BurnInMode } from '@/types/kiosk';

interface KioskDimmerOverlayProps {
  visible: boolean;
  /**
   * Risveglio richiesto dal tocco sull'overlay. Il tap viene comunque
   * consumato qui (`preventDefault` + `stopPropagation`) prima di chiamarlo.
   */
  onWake?: () => void;
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
 * Il tocco di risveglio è gestito in due punti complementari:
 * - `useKioskDimmer` consuma `pointerdown` in fase di capture su `window`,
 *   quindi il primo tocco non arriva nemmeno a React;
 * - questo layer intercetta `pointerdown` in capture per tutta la durata della
 *   dissolvenza, così `pointerup`/`click` residui non colpiscono il controllo
 *   che si trovava sotto il dito (`pointer-events` resta `auto` fino alla fine
 *   del fade, non un istante prima).
 */
export function KioskDimmerOverlay({
  visible,
  onWake,
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

  /**
   * Resta sopra al contenuto per **tutta** la dissolvenza: se il layer
   * diventasse `pointer-events-none` appena `visible` passa a `false`, i tocchi
   * dei ~900 ms di fade arriverebbero ai widget sottostanti (ghost tap).
   */
  const [interactive, setInteractive] = useState(visible);

  useEffect(() => {
    if (visible) {
      setInteractive(true);
      return;
    }
    // Stesso tempo della transizione CSS: poi il layer torna trasparente ai tocchi.
    const timer = window.setTimeout(() => setInteractive(false), fadeMs);
    return () => window.clearTimeout(timer);
  }, [visible, fadeMs]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Il gesto è del dimmer: niente focus, niente click sintetico sul widget
      // sotto, niente propagazione a un eventuale handler globale.
      event.preventDefault();
      event.stopPropagation();
      // Durante il fade il layer assorbe i tocchi residui ma non richiama
      // `wake` una seconda volta: lo stato è già `awake`.
      if (visible) onWake?.();
    },
    [onWake, visible],
  );

  return (
    <div
      aria-hidden={!visible}
      data-testid="kiosk-dimmer-overlay"
      onPointerDownCapture={handlePointerDown}
      className={cn(
        'fixed inset-0 z-[80] overflow-hidden bg-black',
        interactive ? 'pointer-events-auto' : 'pointer-events-none',
        visible ? 'opacity-100' : 'invisible opacity-0',
      )}
      style={{
        // Nessun panning/pinch/doppio-tap-zoom durante il tocco a schermo nero:
        // i gesti nativi ruberebbero il pointerdown al risveglio.
        touchAction: 'none',
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
