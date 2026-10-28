import { useQuery } from '@tanstack/react-query';
import { Activity, BatteryCharging, Gauge, PlugZap, Zap } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { LivePowerCard } from '@/components/widgets/LivePowerCard';
import { SummaryCard } from '@/components/widgets/SummaryCard';
import { TelemetryChart } from '@/components/TelemetryChart';
import { useDevice } from '@/hooks/useDevice';
import { useDevices } from '@/hooks/useTopologyQuery';
import {
  fetchTelemetrySummary,
  formatTelemetryValue,
  type TelemetryMetric,
  type TelemetryRange,
} from '@/lib/telemetry';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn, formatKwh, formatWatts, percent } from '@/lib/utils';
import { useHomeStore, type HomeState } from '@/store/homeStore';
import type { Device } from '@/types/device';

const CONTRACT_LIMIT_W = 3_300;
const ENERGY_PRICE_EUR_KWH = 0.28;

/**
 * Dispositivi con un contatore di potenza: prese (`kind: 'power'`), sensori che
 * dichiarano la metrica `power`/`energy` e attuatori Shelly con meter
 * integrato. Il vecchio filtro solo-`power` escludeva proprio questi ultimi,
 * che pubblicano comunque `apower`/`aenergy` sul broker.
 */
function hasPowerMeter(device: Device): boolean {
  if (device.kind === 'power') return true;
  if (device.kind === 'sensor') {
    return device.state.type === 'power' || device.state.type === 'energy';
  }
  return device.adapter === 'shelly' && device.kind !== 'camera';
}

// ── Selettori ───────────────────────────────────────────────────────────────
// Le metriche di casa sono ricavate in un colpo solo dai soli id delle prese:
// niente `combineDevice` a ogni tick, niente sottoscrizione alla mappa intera.

interface PowerTotals {
  watts: number;
  todayKwh: number;
  active: number;
  load: number;
}

function powerTotals(deviceIds: readonly string[], state: HomeState): PowerTotals {
  let watts = 0;
  let todayKwh = 0;
  let active = 0;

  for (const id of deviceIds) {
    const row = state.deviceStates[id];
    if (!row || row.kind !== 'power') continue;
    todayKwh += row.state.energyTodayKwh;
    if (row.state.on) {
      watts += row.state.watts;
      active += 1;
    }
  }

  return {
    // Valori arrotondati a ciò che l'UI mostra: una variazione invisibile non
    // deve produrre un nuovo snapshot shallow.
    watts: Math.round(watts),
    todayKwh: Number(todayKwh.toFixed(2)),
    active,
    load: percent(watts, CONTRACT_LIMIT_W),
  };
}

function totalTodayKwh(deviceIds: readonly string[], state: HomeState): number {
  let total = 0;
  for (const id of deviceIds) {
    const row = state.deviceStates[id];
    if (row?.kind === 'power') total += row.state.energyTodayKwh;
  }
  return Number(total.toFixed(2));
}

/** Id ordinati per consumo istantaneo: `useShallow` evita reorder inutili. */
function orderedByWatts(deviceIds: readonly string[], state: HomeState): string[] {
  return deviceIds
    .map((id) => {
      const row = state.deviceStates[id];
      const watts = row?.kind === 'power' && row.state.on ? Math.round(row.state.watts) : 0;
      return { id, watts };
    })
    .sort((a, b) => b.watts - a.watts)
    .map((entry) => entry.id);
}

interface TelemetryStatProps {
  label: string;
  value: string;
}

/** Riepilogo compatto della finestra storica selezionata. */
function TelemetryStat({ label, value }: TelemetryStatProps) {
  return (
    <div className="rounded-xl border border-line bg-panel-2/40 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="tabular mt-0.5 text-sm font-medium text-fg">{value}</dd>
    </div>
  );
}

/** KPI di casa: snapshot arrotondato, isolato dal resto della pagina. */
function EnergySummary({ deviceIds }: { deviceIds: readonly string[] }) {
  const { t } = useTranslation('energy');
  const { watts, todayKwh, active, load } = useHomeStore(
    useShallow((state) => powerTotals(deviceIds, state)),
  );
  const estimatedCost = todayKwh * ENERGY_PRICE_EUR_KWH;

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
      <SummaryCard
        label={t('summary.instantLoad.label')}
        value={formatWatts(watts)}
        hint={t('summary.instantLoad.hint', { active, total: deviceIds.length })}
        icon={Zap}
        tone={load > 85 ? 'danger' : 'accent'}
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
        hint={t('summary.contracted.hint', { percent: load })}
        icon={Gauge}
        tone={load > 85 ? 'danger' : 'neutral'}
      />
      <SummaryCard
        label={t('summary.average.label')}
        value={formatWatts(active > 0 ? watts / active : 0)}
        hint={t('summary.average.hint')}
        icon={Activity}
      />
    </section>
  );
}

/** Badge "consumo attuale": osserva solo il totale arrotondato. */
function LiveConsumptionBadge({ deviceIds }: { deviceIds: readonly string[] }) {
  const { t } = useTranslation('energy');
  const watts = useHomeStore((state) => powerTotals(deviceIds, state).watts);

  return (
    <span className="tabular rounded-full border border-line px-2.5 py-1 text-[10px] text-fg-subtle">
      {t('telemetry.live', { value: formatWatts(watts) })}
    </span>
  );
}

/**
 * Prese live. Il subtree osserva solo l'ordine per consumo; i valori restano
 * dentro `LivePowerCard`, che è `memo` + `useShallow`.
 */
const LivePowerSection = memo(function LivePowerSection({
  deviceIds,
}: {
  deviceIds: readonly string[];
}) {
  const { t } = useTranslation('energy');
  const ordered = useHomeStore(useShallow((state) => orderedByWatts(deviceIds, state)));

  if (deviceIds.length === 0) return null;

  return (
    <section aria-labelledby="live-power-title" className="flex flex-col gap-3">
      <div>
        <h2 id="live-power-title" className="text-sm font-semibold text-fg">
          {t('live.title')}
        </h2>
        <p className="mt-0.5 text-[11px] text-fg-subtle">{t('live.hint')}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {ordered.map((deviceId) => (
          <LivePowerCard key={deviceId} deviceId={deviceId} />
        ))}
      </div>
    </section>
  );
});

/** Picco/media dalla query storica + energia di oggi dalla telemetria. */
function TelemetrySummaryStats({
  deviceIds,
  metric,
  peak,
  average,
}: {
  deviceIds: readonly string[];
  metric: TelemetryMetric;
  peak: number | null;
  average: number | null;
}) {
  const { t } = useTranslation('energy');
  const todayKwh = useHomeStore((state) => totalTodayKwh(deviceIds, state));

  return (
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-1">
      <TelemetryStat
        label={t('telemetry.stats.peak')}
        value={peak != null ? formatTelemetryValue(metric, peak) : '—'}
      />
      <TelemetryStat
        label={t('telemetry.stats.average')}
        value={average != null ? formatTelemetryValue(metric, average) : '—'}
      />
      <TelemetryStat label={t('telemetry.stats.today')} value={formatKwh(todayKwh)} />
    </dl>
  );
}

/** Bilancio contratto: un solo totale, nessun re-render della pagina. */
const BalanceSection = memo(function BalanceSection({
  deviceIds,
}: {
  deviceIds: readonly string[];
}) {
  const { t } = useTranslation('energy');
  const { watts, load } = useHomeStore(
    useShallow((state) => powerTotals(deviceIds, state)),
  );

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t('balance.title')}</h2>
          <p className="mt-0.5 text-[11px] text-fg-subtle">{t('balance.hint')}</p>
        </div>
        <span
          className={cn(
            'tabular text-2xl font-light',
            load > 85 ? 'text-danger' : load > 60 ? 'text-warning' : 'text-fg',
          )}
        >
          {load}%
        </span>
      </div>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-elevated">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700',
            load > 85 ? 'bg-danger' : load > 60 ? 'bg-warning' : 'bg-accent',
          )}
          style={{ width: `${load}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-fg-subtle">
        <span>0 W</span>
        <span>{t('balance.drawn', { value: formatWatts(watts) })}</span>
        <span>{formatWatts(CONTRACT_LIMIT_W)}</span>
      </div>
    </section>
  );
});

/**
 * Riga presa: sottoscrive solo la propria riga (`useDevice`) e riceve il
 * totale giornaliero già arrotondato, che serve unicamente alla percentuale.
 */
const SocketRow = memo(function SocketRow({
  deviceId,
  totalKwh,
}: {
  deviceId: string;
  totalKwh: number;
}) {
  const { t } = useTranslation('energy');
  const { sendAction } = useMqttApi();
  const requestPin = usePinGuard();
  const device = useDevice(deviceId);

  if (!device || device.kind !== 'power') return null;

  const load = percent(device.state.watts, device.state.maxWatts);
  const share = percent(device.state.energyTodayKwh, totalKwh || 1);

  const toggle = () => {
    const on = !device.state.on;
    if (device.protected) {
      requestPin({
        title: t('guard.title'),
        description: t('guard.description', { name: device.name }),
        onConfirm: () => sendAction(deviceId, { type: 'power', on }),
      });
      return;
    }
    sendAction(deviceId, { type: 'power', on });
  };

  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl border',
          device.state.on
            ? 'border-accent/20 bg-accent-soft text-accent'
            : 'border-line bg-panel-2 text-fg-subtle',
        )}
      >
        <PlugZap className="size-4.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-fg">{device.name}</p>
          <span className="tabular shrink-0 text-sm font-medium text-fg">
            {formatWatts(device.state.watts)}
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
            {device.state.on ? t('sockets.active') : t('sockets.inactive')} ·{' '}
            {t('sockets.loadMax', { percent: load })}
          </span>
          <span className="tabular">
            {t('sockets.todayShare', {
              value: formatKwh(device.state.energyTodayKwh),
              percent: share,
            })}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium',
            device.state.on
              ? 'border-accent/30 bg-accent-soft text-accent'
              : 'border-line bg-panel-2 text-fg-subtle',
          )}
        >
          {device.state.on ? 'ON' : 'OFF'}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={device.state.on}
          onClick={toggle}
          className={cn(
            'relative h-8 w-14 rounded-full border-2 border-transparent transition-colors',
            device.state.on ? 'bg-accent' : 'bg-elevated',
          )}
          aria-label={t('sockets.toggleAria', { name: device.name })}
        >
          <span
            className={cn(
              'absolute top-0.5 size-6 rounded-full transition-transform',
              device.state.on ? 'translate-x-6 bg-accent-fg' : 'translate-x-1 bg-fg-muted',
            )}
          />
        </button>
      </div>
    </li>
  );
});

/** Elenco prese: osserva ordine per consumo e totale giornaliero. */
const SocketsSection = memo(function SocketsSection({
  deviceIds,
}: {
  deviceIds: readonly string[];
}) {
  const { t } = useTranslation('energy');
  const ordered = useHomeStore(useShallow((state) => orderedByWatts(deviceIds, state)));
  const todayKwh = useHomeStore((state) => totalTodayKwh(deviceIds, state));

  return (
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
        {deviceIds.length === 0 ? (
          <p className="p-6 text-center text-xs text-fg-subtle">{t('sockets.empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {ordered.map((deviceId) => (
              <SocketRow key={deviceId} deviceId={deviceId} totalKwh={todayKwh} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
});

export function EnergyPage() {
  const { t } = useTranslation('energy');
  // Anagrafica da TanStack Query: la pagina non legge la telemetria. Ogni
  // metrica volatile (totali, ordine per consumo, righe) vive nei subtree qui
  // sotto, che si iscrivono con selettori atomici.
  const devices = useDevices();
  const powerDeviceIds = useMemo(
    () => devices.filter((device) => device.kind === 'power').map((device) => device.id),
    [devices],
  );

  // Storico e riepiloghi: stessi selettori del grafico, così picco e media
  // descrivono esattamente la finestra e la metrica visualizzate.
  const meterDevices = useMemo(() => devices.filter(hasPowerMeter), [devices]);
  // 'house' = somma di tutti i meter; altrimenti lo slug del singolo device.
  const [selectedScope, setSelectedScope] = useState<string>('house');
  const [activeRange, setActiveRange] = useState<TelemetryRange>('24h');
  const [activeMetric, setActiveMetric] = useState<TelemetryMetric>('power_watts');
  const hasMeters = meterDevices.length > 0;
  const activeDevice = meterDevices.find((device) => device.id === selectedScope) ?? null;
  // `null` = aggregato di casa: è il valore che il server interpreta come
  // "nessun filtro device" e somma per bucket.
  const activeDeviceId = activeDevice?.id ?? null;
  const houseSelected = activeDeviceId === null;

  const summaryQuery = useQuery({
    queryKey: ['telemetry', activeDeviceId ?? 'house', activeRange, activeMetric, 'summary'],
    queryFn: ({ signal }) =>
      fetchTelemetrySummary(activeDeviceId, activeMetric, activeRange, signal),
    enabled: hasMeters,
    staleTime: 60_000,
  });
  const summary = summaryQuery.data;

  return (
    <div className="flex flex-col gap-5">
      <EnergySummary deviceIds={powerDeviceIds} />

      <LivePowerSection deviceIds={powerDeviceIds} />

      <section
        aria-labelledby="telemetry-title"
        className="rounded-[var(--radius-card)] border border-line bg-panel p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="telemetry-title" className="text-sm font-semibold text-fg">
              {t('telemetry.title')}
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">{t('telemetry.hint')}</p>
          </div>
          {/* Il consumo reale resta leggibile anche con lo storico ancora vuoto. */}
          <LiveConsumptionBadge deviceIds={powerDeviceIds} />
        </div>

        {meterDevices.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label={t('telemetry.deviceAria')}>
              <button
                type="button"
                onClick={() => setSelectedScope('house')}
                aria-pressed={houseSelected}
                className={cn(
                  'min-h-9 rounded-full border px-3 text-[11px] font-medium transition-colors',
                  houseSelected
                    ? 'border-accent/30 bg-accent-soft text-accent'
                    : 'border-line bg-panel-2 text-fg-subtle',
                )}
              >
                {t('telemetry.house')}
              </button>
              {meterDevices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  onClick={() => setSelectedScope(device.id)}
                  aria-pressed={device.id === activeDeviceId}
                  className={cn(
                    'min-h-9 rounded-full border px-3 text-[11px] font-medium transition-colors',
                    device.id === activeDeviceId
                      ? 'border-accent/30 bg-accent-soft text-accent'
                      : 'border-line bg-panel-2 text-fg-subtle',
                  )}
                >
                  {device.name}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-1" role="group" aria-label={t('telemetry.metricAria')}>
              {(['power_watts', 'energy_kwh'] as const).map((metric) => (
                <button
                  key={metric}
                  type="button"
                  onClick={() => setActiveMetric(metric)}
                  aria-pressed={activeMetric === metric}
                  className={cn(
                    'min-h-9 rounded-full border px-3 text-[11px] font-medium transition-colors',
                    activeMetric === metric
                      ? 'border-accent/30 bg-accent-soft text-accent'
                      : 'border-line bg-panel-2 text-fg-subtle',
                  )}
                >
                  {t(`metric.${metric}`)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_220px]">
          <TelemetryChart
            deviceId={activeDeviceId}
            metric={activeMetric}
            range={activeRange}
            onRangeChange={setActiveRange}
            enabled={hasMeters}
          />
          <TelemetrySummaryStats
            deviceIds={powerDeviceIds}
            metric={activeMetric}
            peak={summary?.max ?? null}
            average={summary?.avg ?? null}
          />
        </div>
      </section>

      <BalanceSection deviceIds={powerDeviceIds} />

      <SocketsSection deviceIds={powerDeviceIds} />
    </div>
  );
}
