import { Clock3, Hourglass, Infinity as InfinityIcon, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { formatTemp } from '@/lib/utils';
import type { ClimateOverrideDuration } from '@/types/climate';

interface ClimateOverridePromptProps {
  deviceName: string;
  /** Setpoint appena impostato a mano: è quello che l'override deve mantenere. */
  targetTemp: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (duration: ClimateOverrideDuration) => void;
  /** Epoch ms del prossimo cambio orario, `null` se il programma è vuoto. */
  nextChangeAt: number | null;
  pending?: boolean;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Compare dopo che l'utente ha mosso la manopola su un cronotermostato
 * programmato: senza una durata esplicita il job riallineerebbe il setpoint
 * entro un minuto, quindi la scelta va fatta subito, con bersagli da 56 px.
 */
export function ClimateOverridePrompt({
  deviceName,
  targetTemp,
  open,
  onOpenChange,
  onChoose,
  nextChangeAt,
  pending = false,
}: ClimateOverridePromptProps) {
  const { t } = useTranslation('devices');
  const durations = [1, 2, 4] as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,28rem)]">
        <DialogTitle className="flex items-center gap-2 pr-8">
          <Hourglass className="size-4 text-warning" aria-hidden />
          {t('climate.override.title', { temp: formatTemp(targetTemp) })}
        </DialogTitle>
        <DialogDescription>
          {deviceName} · {t('climate.override.description')}
        </DialogDescription>

        <div className="mt-4 flex flex-col gap-2">
          {nextChangeAt !== null ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => onChoose({ until: 'next_schedule' })}
              className="flex h-14 items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 text-left text-[12px] font-medium text-accent transition-colors hover:bg-accent/15 disabled:opacity-40"
            >
              <Clock3 className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">{t('climate.override.nextChange')}</span>
              <span className="tabular text-[11px] text-accent/80">
                {formatClock(nextChangeAt)}
              </span>
            </button>
          ) : null}

          <div className="grid grid-cols-3 gap-1.5">
            {durations.map((hours) => (
              <button
                key={hours}
                type="button"
                disabled={pending}
                onClick={() => onChoose({ minutes: hours * 60 })}
                className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl border border-line bg-panel-2 text-[12px] font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-40"
              >
                <Timer className="size-4 text-fg-subtle" aria-hidden />
                {t('climate.override.hours', { count: hours })}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={() => onChoose({ until: 'permanent' })}
            className="flex h-14 items-center gap-3 rounded-xl border border-line bg-panel-2 px-4 text-left text-[12px] font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-40"
          >
            <InfinityIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            <span className="flex-1">{t('climate.override.keepPermanent')}</span>
          </button>
        </div>

        <p className="mt-3 text-[11px] text-fg-subtle">{t('climate.override.dismissHint')}</p>
      </DialogContent>
    </Dialog>
  );
}
