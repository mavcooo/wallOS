import { PlugZap } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { Switch } from '@/components/ui/switch';
import { useDeviceMetadata } from '@/hooks/useTopologyQuery';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn, formatKwh, formatWatts, percent } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';

interface LivePowerCardProps {
  deviceId: string;
  className?: string;
}

/**
 * Esempio di consumo isolato.
 *
 * - La pagina non passa l'oggetto device: passa solo l'id stabile.
 * - `useShallow` confronta il sottoinsieme di metriche e impedisce il render
 *   quando il flush riguarda altre prese o quando cambiano solo decimali
 *   non visualizzati.
 * - `memo` evita il render anche quando il parent pagina si aggiorna.
 */
export const LivePowerCard = memo(function LivePowerCard({
  deviceId,
  className,
}: LivePowerCardProps) {
  const { t } = useTranslation('devices');
  const { t: tEnergy } = useTranslation('energy');
  // Metadati stabili da TanStack Query, telemetria dalla sola riga del device.
  const metadata = useDeviceMetadata(deviceId);
  const metrics = useHomeStore(
    useShallow((state) => {
      const row = state.deviceStates[deviceId];
      if (!row || row.kind !== 'power' || !metadata) return null;
      return {
        name: metadata.name,
        on: row.state.on,
        // Metriche già arrotondate a ciò che l'UI mostra: niente render per
        // variazioni invisibili sotto l'unità.
        watts: Math.round(row.state.watts),
        volts: Math.round(row.state.voltage),
        todayKwh: Number(row.state.energyTodayKwh.toFixed(2)),
        maxWatts: row.state.maxWatts,
        load: percent(row.state.watts, row.state.maxWatts),
        protected: metadata.protected,
      };
    }),
  );
  const { sendAction } = useMqttApi();
  const requestPin = usePinGuard();

  if (!metrics) return null;

  const toggle = (on: boolean) => {
    if (metrics.protected) {
      requestPin({
        title: tEnergy('guard.title'),
        description: tEnergy('guard.description', { name: metrics.name }),
        onConfirm: () => sendAction(deviceId, { type: 'power', on }),
      });
      return;
    }
    sendAction(deviceId, { type: 'power', on });
  };

  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-panel p-4',
        className,
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-xl border transition-colors',
              metrics.on
                ? 'border-accent/25 bg-accent-soft text-accent'
                : 'border-line bg-panel-2 text-fg-subtle',
            )}
          >
            <PlugZap className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-fg">{metrics.name}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-subtle">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  metrics.on ? 'bg-accent' : 'bg-fg-subtle/50',
                )}
              />
              {metrics.on ? t('live.underLoad') : t('live.standby')}
            </p>
          </div>
        </div>
        <Switch
          checked={metrics.on}
          onCheckedChange={toggle}
          aria-label={t('power.toggleAria', { name: metrics.name })}
        />
      </header>

      <div className="flex items-end justify-between gap-2">
        <span className="tabular text-2xl font-light leading-none text-fg">
          {formatWatts(metrics.watts)}
        </span>
        <span className="tabular text-[10px] text-fg-subtle">{metrics.volts} V</span>
      </div>

      <div>
        <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              metrics.load > 85
                ? 'bg-danger'
                : metrics.load > 60
                  ? 'bg-warning'
                  : 'bg-accent',
            )}
            style={{ width: `${metrics.load}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
          <span className="tabular">
            {t('power.today', { value: formatKwh(metrics.todayKwh) })}
          </span>
          <span className="tabular">
            {t('power.loadOf', { value: metrics.load, max: formatWatts(metrics.maxWatts) })}
          </span>
        </div>
      </div>
    </article>
  );
});
