import { Activity, BatteryCharging, Gauge, PlugZap, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { LivePowerCard } from '@/components/widgets/LivePowerCard';
import { SummaryCard } from '@/components/widgets/SummaryCard';
import { TelemetryChart } from '@/components/TelemetryChart';
import { useDevices } from '@/hooks/useTopologyQuery';
import { combineDevice } from '@/lib/deviceState';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn, formatKwh, formatWatts, percent } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import type { PowerDevice } from '@/types/device';

const CONTRACT_LIMIT_W = 3_300;
const ENERGY_PRICE_EUR_KWH = 0.28;

export function EnergyPage() {
  const { t } = useTranslation('energy');
  const { sendAction } = useMqttApi();
  const requestPin = usePinGuard();
  // Anagrafica da TanStack Query; le prese sono l'unico sottoinsieme di cui
  // questa pagina osserva la telemetria.
  const devices = useDevices();
  const powerDevices = useMemo(
    () => devices.filter((device) => device.kind === 'power'),
    [devices],
  );
  const rows = useHomeStore(
    useShallow((state) => powerDevices.map((device) => state.deviceStates[device.id])),
  );
  const sockets = useMemo(
    () =>
      powerDevices
        .flatMap((metadata, index) => {
          const device = combineDevice(metadata, rows[index]);
          return device?.kind === 'power' ? [device] : [];
        })
        .sort((a, b) => b.state.watts - a.state.watts),
    [powerDevices, rows],
  );

  const instantaneous = sockets.reduce((sum, socket) => sum + socket.state.watts, 0);
  const todayKwh = sockets.reduce((sum, socket) => sum + socket.state.energyTodayKwh, 0);
  const activeSockets = sockets.filter((socket) => socket.state.on).length;
  const contractLoad = percent(instantaneous, CONTRACT_LIMIT_W);
  const estimatedCost = todayKwh * ENERGY_PRICE_EUR_KWH;

  const toggleSocket = (socket: PowerDevice, on: boolean) => {
    if (socket.protected) {
      requestPin({
        title: t('guard.title'),
        description: t('guard.description', { name: socket.name }),
        onConfirm: () => sendAction(socket.id, { type: 'power', on }),
      });
      return;
    }
    sendAction(socket.id, { type: 'power', on });
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        <SummaryCard
          label={t('summary.instantLoad.label')}
          value={formatWatts(instantaneous)}
          hint={t('summary.instantLoad.hint', {
            active: activeSockets,
            total: sockets.length,
          })}
          icon={Zap}
          tone={contractLoad > 85 ? 'danger' : 'accent'}
        />
        <SummaryCard
          label={t('summary.daily.label')}
          value={formatKwh(todayKwh)}
          hint={t('summary.daily.hint', { cost: estimatedCost.toFixed(2) })}
          icon={BatteryCharging}
        />
        <SummaryCard
          label={t('summary.contracted.label')}
          value={formatWatts(CONTRACT_LIMIT_W)}
          hint={t('summary.contracted.hint', { percent: contractLoad })}
          icon={Gauge}
          tone={contractLoad > 85 ? 'danger' : 'neutral'}
        />
        <SummaryCard
          label={t('summary.average.label')}
          value={formatWatts(activeSockets > 0 ? instantaneous / activeSockets : 0)}
          hint={t('summary.average.hint')}
          icon={Activity}
        />
      </section>

      {sockets.length > 0 ? (
        <section aria-labelledby="live-power-title" className="flex flex-col gap-3">
          <div>
            <h2 id="live-power-title" className="text-sm font-semibold text-fg">
              {t('live.title')}
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">{t('live.hint')}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
            {sockets.map((socket) => (
              <LivePowerCard key={socket.id} deviceId={socket.id} />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="telemetry-title" className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
        <div>
          <h2 id="telemetry-title" className="text-sm font-semibold text-fg">{t('telemetry.title')}</h2>
          <p className="mt-0.5 text-[11px] text-fg-subtle">{t('telemetry.hint')}</p>
        </div>
        <div className="mt-3">
          <TelemetryChart
            deviceId={powerDevices[0]?.id || ''}
            metric="power_watts"
            range="24h"
          />
        </div>
      </section>

      <section className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-sm font-semibold text-fg">{t('balance.title')}</h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">{t('balance.hint')}</p>
          </div>
          <span
            className={cn(
              'tabular text-2xl font-light',
              contractLoad > 85 ? 'text-danger' : contractLoad > 60 ? 'text-warning' : 'text-fg',
            )}
          >
            {contractLoad}%
          </span>
        </div>
        <div className="mt-4 h-3 overflow-hidden rounded-full bg-elevated">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-700',
              contractLoad > 85 ? 'bg-danger' : contractLoad > 60 ? 'bg-warning' : 'bg-accent',
            )}
            style={{ width: `${contractLoad}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-fg-subtle">
          <span>0 W</span>
          <span>{t('balance.drawn', { value: formatWatts(instantaneous) })}</span>
          <span>{formatWatts(CONTRACT_LIMIT_W)}</span>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-fg">{t('sockets.title')}</h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">{t('sockets.hint')}</p>
          </div>
          <span className="rounded-full border border-line px-2.5 py-1 text-[10px] text-fg-subtle">
            {t('sockets.todayBadge', { value: formatKwh(todayKwh) })}
          </span>
        </div>

        <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel">
          {sockets.length === 0 ? (
            <p className="p-6 text-center text-xs text-fg-subtle">{t('sockets.empty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {sockets.map((socket) => {
                const load = percent(socket.state.watts, socket.state.maxWatts);
                const share = percent(socket.state.energyTodayKwh, todayKwh || 1);
                return (
                  <li
                    key={socket.id}
                    className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <span
                      className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-xl border',
                        socket.state.on
                          ? 'border-accent/20 bg-accent-soft text-accent'
                          : 'border-line bg-panel-2 text-fg-subtle',
                      )}
                    >
                      <PlugZap className="size-4.5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-fg">{socket.name}</p>
                        <span className="tabular shrink-0 text-sm font-medium text-fg">
                          {formatWatts(socket.state.watts)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elevated">
                        <div
                          className={cn(
                            'h-full rounded-full transition-[width] duration-500',
                            load > 85 ? 'bg-danger' : load > 60 ? 'bg-warning' : 'bg-accent',
                          )}
                          style={{ width: `${load}%` }}
                        />
                      </div>
                      <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
                        <span>
                          {socket.state.on ? t('sockets.active') : t('sockets.inactive')} ·{' '}
                          {t('sockets.loadMax', { percent: load })}
                        </span>
                        <span className="tabular">
                          {t('sockets.todayShare', {
                            value: formatKwh(socket.state.energyTodayKwh),
                            percent: share,
                          })}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 sm:justify-end">
                      <span
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                          socket.state.on
                            ? 'border-accent/30 bg-accent-soft text-accent'
                            : 'border-line bg-panel-2 text-fg-subtle',
                        )}
                      >
                        {socket.state.on ? 'ON' : 'OFF'}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={socket.state.on}
                        onClick={() => toggleSocket(socket, !socket.state.on)}
                        className={cn(
                          'relative h-8 w-14 rounded-full border-2 border-transparent transition-colors',
                          socket.state.on ? 'bg-accent' : 'bg-elevated',
                        )}
                        aria-label={t('sockets.toggleAria', { name: socket.name })}
                      >
                        <span
                          className={cn(
                            'absolute top-0.5 size-6 rounded-full transition-transform',
                            socket.state.on
                              ? 'translate-x-6 bg-accent-fg'
                              : 'translate-x-1 bg-fg-muted',
                          )}
                        />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
