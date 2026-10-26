import { AlertCircle, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { Device } from '@/types/device';

/** Minuti interi trascorsi da un timestamp; `null` se non c'è un riferimento. */
export function minutesSince(timestamp: number | null, now: number = Date.now()): number | null {
  if (!timestamp) return null;
  return Math.max(0, Math.floor((now - timestamp) / 60_000));
}

interface AvailabilityBadgeProps {
  device: Pick<Device, 'availability' | 'lastSeen' | 'isAvailable'>;
  className?: string;
}

/**
 * Feedback compatto di device non raggiungibile.
 *
 * Il testo è sempre visibile (kiosk touch: niente hover garantito) e il
 * `title`/`aria-label` aggiunge il dettaglio temporale per chi usa mouse o
 * screen reader: "Offline da 12 min" / "Nessuna lettura da 34 min".
 */
export function AvailabilityBadge({ device, className }: AvailabilityBadgeProps) {
  const { t } = useTranslation('devices');
  if (device.isAvailable !== false) return null;

  const stale = device.availability === 'stale';
  const minutes = minutesSince(device.lastSeen);
  const hint =
    minutes && minutes > 0
      ? t(stale ? 'availability.staleSince' : 'availability.offlineSince', { minutes })
      : t(stale ? 'availability.staleHint' : 'availability.offlineHint');
  const Icon = stale ? AlertCircle : WifiOff;

  return (
    <span
      role="status"
      title={hint}
      aria-label={hint}
      data-availability={stale ? 'stale' : 'offline'}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        stale
          ? 'border-warning/35 bg-warning/10 text-warning'
          : 'border-danger/35 bg-danger/10 text-danger',
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {t(stale ? 'availability.stale' : 'availability.offline')}
    </span>
  );
}
