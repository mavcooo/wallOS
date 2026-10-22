import { Lightbulb, Star } from 'lucide-react';
import { useEffect, useState } from 'react';

import { roomLabel } from '@/config/rooms.config';
import { useHomeStore } from '@/store/homeStore';
import { cn } from '@/lib/utils';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type { ControlAction, LightDevice } from '@/types/device';
import { SyncIndicator } from './SyncIndicator';

interface LightCardProps {
  device: LightDevice;
  onAction: (action: ControlAction) => void;
  onToggleFavorite?: () => void;
  /** Comando in coda, in attesa di conferma dal broker. */
  pending?: boolean;
  className?: string;
}

const PRESETS = [
  { label: 'Calda', kelvin: 2400 },
  { label: 'Neutra', kelvin: 3500 },
  { label: 'Fredda', kelvin: 5500 },
] as const;

export function LightCard({
  device,
  onAction,
  onToggleFavorite,
  pending = false,
  className,
}: LightCardProps) {
  const { state, capabilities } = device;
  const rooms = useHomeStore((store) => store.rooms);
  const [brightness, setBrightness] = useState(state.brightness);

  useEffect(() => {
    setBrightness(state.brightness);
  }, [state.brightness]);

  const active = state.on;

  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-[var(--radius-card)] border p-4 transition-colors',
        active ? 'border-line bg-panel' : 'border-line/70 bg-panel/60',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors',
              active
                ? 'border-warning/25 bg-warning/10 text-warning'
                : 'border-line bg-panel-2 text-fg-subtle',
            )}
          >
            <Lightbulb className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <span className="truncate">{device.name}</span>
              <SyncIndicator pending={pending} />
            </p>
            <p className="truncate text-[11px] text-fg-subtle">
              {roomLabel(rooms, device.room)}
              {active ? ` · ${brightness}%` : ' · spenta'}
            </p>
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
            checked={active}
            onCheckedChange={(on) => onAction({ type: 'power', on })}
            aria-label={`Accendi o spegni ${device.name}`}
          />
        </div>
      </div>

      <div className={cn('transition-opacity', !active && 'opacity-45')}>
        <div className="flex items-end justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
            Intensità
          </span>
          <span className="tabular text-2xl font-light leading-none text-fg">
            {brightness}
            <span className="ml-0.5 text-sm text-fg-muted">%</span>
          </span>
        </div>
        <Slider
          value={[brightness]}
          min={0}
          max={100}
          step={1}
          disabled={!capabilities.dimmable}
          onValueChange={(values) => setBrightness(values[0] ?? 0)}
          onValueCommit={(values) => {
            const next = values[0] ?? 0;
            onAction({ type: 'brightness', brightness: next });
          }}
          aria-label={`Luminosità ${device.name}`}
          className="mt-1"
        />
      </div>

      {capabilities.colorTempRange ? (
        <div className="flex items-center gap-1.5">
          {PRESETS.map((preset) => {
            const range = capabilities.colorTempRange;
            const disabled = !range || preset.kelvin < range[0] || preset.kelvin > range[1];
            const selected = state.colorTemp !== undefined && Math.abs(state.colorTemp - preset.kelvin) < 200;
            return (
              <button
                key={preset.kelvin}
                type="button"
                disabled={disabled || !active}
                onClick={() => onAction({ type: 'colorTemp', kelvin: preset.kelvin })}
                className={cn(
                  'h-9 flex-1 rounded-lg border text-[11px] font-medium transition-colors',
                  selected
                    ? 'border-accent/40 bg-accent-soft text-accent'
                    : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                  'disabled:opacity-30',
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
