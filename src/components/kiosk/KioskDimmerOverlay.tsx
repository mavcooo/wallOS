import { KIOSK_DEFAULTS } from '@/config/app.config';
import { useClock } from '@/hooks/useClock';
import { cn, formatDate, formatTime } from '@/lib/utils';

interface KioskDimmerOverlayProps {
  visible: boolean;
  fadeMs?: number;
  clockOpacity?: number;
}

/**
 * Overlay di standby: nero pieno, orologio a luminosità minima.
 * Il tocco viene intercettato da useKioskDimmer in fase di capture, prima che
 * React riceva l'evento: nessun comando parte dal tap di risveglio.
 */
export function KioskDimmerOverlay({
  visible,
  fadeMs = KIOSK_DEFAULTS.dimmerFadeMs,
  clockOpacity = KIOSK_DEFAULTS.sleepClockOpacity,
}: KioskDimmerOverlayProps) {
  const now = useClock(1000);

  return (
    <div
      aria-hidden={!visible}
      data-testid="kiosk-dimmer-overlay"
      className={cn(
        'fixed inset-0 z-[80] flex flex-col items-center justify-center bg-black',
        'pointer-events-auto transition-opacity ease-out',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      style={{ transitionDuration: `${fadeMs}ms` }}
    >
      <div
        className="flex flex-col items-center gap-2 tabular transition-opacity"
        style={{ opacity: clockOpacity, transitionDuration: `${fadeMs}ms` }}
      >
        <span className="text-[13vw] font-extralight leading-none tracking-tight text-white">
          {formatTime(now).slice(0, 5)}
        </span>
        <span className="text-xl font-light text-white/80">{formatDate(now)}</span>
        <span className="mt-6 text-[11px] uppercase tracking-[0.35em] text-white/50">
          Standby · tocca per riattivare
        </span>
      </div>
    </div>
  );
}
