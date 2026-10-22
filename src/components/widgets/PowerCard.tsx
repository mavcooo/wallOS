import { Lock, Plug, Star } from 'lucide-react';

import { cn, formatKwh, formatWatts, percent } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import type { ControlAction, PowerDevice } from '@/types/device';
import { SyncIndicator } from './SyncIndicator';

interface PowerCardProps {
  device: PowerDevice;
  onAction: (action: ControlAction) => void;
  onToggleFavorite?: () => void;
  /** Comando in coda, in attesa di conferma dal broker. */
  pending?: boolean;
  className?: string;
}

export function PowerCard({
  device,
  onAction,
  onToggleFavorite,
  pending = false,
  className,
}: PowerCardProps) {
  const { state } = device;
  const load = percent(state.watts, state.maxWatts);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-panel p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl border',
              state.on
                ? 'border-accent/25 bg-accent-soft text-accent'
                : 'border-line bg-panel-2 text-fg-subtle',
            )}
          >
            <Plug className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
              <span className="truncate">{device.name}</span>
              {device.protected ? <Lock className="size-3 shrink-0 text-fg-subtle" /> : null}
              <SyncIndicator pending={pending} />
            </p>
            <p className="text-[11px] text-fg-subtle">{formatKwh(state.energyTodayKwh)} oggi</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {onToggleFavorite ? (
            <button
              type="button"
              onClick={onToggleFavorite}
              aria-label={device.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
              className="flex size-9 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-elevated hover:text-fg"
            >
              <Star className={cn('size-4', device.favorite && 'fill-accent text-accent')} />
            </button>
          ) : null}
          <Switch
            checked={state.on}
            onCheckedChange={(on) => onAction({ type: 'power', on })}
            aria-label={`Alimenta ${device.name}`}
          />
        </div>
      </div>

      <div className="flex items-end justify-between">
        <span className="tabular text-2xl font-light text-fg">
          {formatWatts(state.watts)}
        </span>
        <span className="tabular text-[10px] text-fg-subtle">
          {state.voltage} V · {state.current} A
        </span>
      </div>

      <div>
        <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              load > 85 ? 'bg-danger' : load > 60 ? 'bg-warning' : 'bg-accent',
            )}
            style={{ width: `${load}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
          <span>Carico</span>
          <span className="tabular">{load}% di {formatWatts(state.maxWatts)}</span>
        </div>
      </div>
    </div>
  );
}
