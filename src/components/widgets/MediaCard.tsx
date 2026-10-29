import { Power, Radio, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Slider } from '@/components/ui/slider';
import type { ControlAction, MediaDevice } from '@/types/device';
import { SyncIndicator } from './SyncIndicator';

interface MediaCardProps {
  device: MediaDevice;
  onAction: (action: ControlAction) => void;
  onToggleFavorite?: () => void;
  /** Comando in coda, in attesa di conferma dal broker. */
  pending?: boolean;
  className?: string;
}

export function MediaCard({ device, onAction, pending = false, className }: MediaCardProps) {
  const { t } = useTranslation('devices');
  const { state } = device;
  const [volume, setVolume] = useState(state.volume);

  useEffect(() => setVolume(state.volume), [state.volume]);

  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-panel p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl border',
              state.power
                ? 'border-cool/25 bg-cool/10 text-cool'
                : 'border-line bg-panel-2 text-fg-subtle',
            )}
          >
            <Radio className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <span className="min-w-0 truncate" title={device.name}>
                {device.name}
              </span>
              <SyncIndicator pending={pending} />
            </p>
            <p className="truncate text-[11px] text-fg-subtle">
              {state.power ? (state.nowPlaying ?? t('media.noSource')) : t('media.off')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onAction({ type: 'power', on: !state.power })}
          className={cn(
            'flex size-10 items-center justify-center rounded-xl border transition-colors',
            state.power
              ? 'border-accent/30 bg-accent-soft text-accent'
              : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
          )}
          aria-label={t(state.power ? 'media.powerOff' : 'media.powerOn')}
        >
          <Power className="size-4" />
        </button>
      </div>

      <div className={cn(!state.power && 'pointer-events-none opacity-40')}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onAction({ type: 'volume', volume: state.muted ? volume : 0 })}
            className="text-fg-muted transition-colors hover:text-fg"
            aria-label={t(state.muted ? 'media.unmute' : 'media.mute')}
          >
            {state.muted || volume === 0 ? (
              <VolumeX className="size-4" />
            ) : (
              <Volume2 className="size-4" />
            )}
          </button>
          <Slider
            value={[volume]}
            min={0}
            max={100}
            step={1}
            onValueChange={(values) => setVolume(values[0] ?? 0)}
            onValueCommit={(values) => onAction({ type: 'volume', volume: values[0] ?? 0 })}
            aria-label={t('media.volumeAria', { name: device.name })}
          />
          <span className="tabular w-8 text-right text-xs text-fg-muted">{volume}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {device.sources.map((source) => (
          <button
            key={source}
            type="button"
            disabled={!state.power}
            onClick={() => onAction({ type: 'source', source })}
            className={cn(
              'h-8 rounded-lg border px-2.5 text-[11px] font-medium transition-colors disabled:opacity-30',
              state.source === source
                ? 'border-accent/40 bg-accent-soft text-accent'
                : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
            )}
          >
            {source}
          </button>
        ))}
      </div>
    </div>
  );
}
