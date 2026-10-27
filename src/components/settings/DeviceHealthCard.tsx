import { Activity, Battery, BatteryCharging, BatteryLow, Cpu, HeartPulse, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BATTERY_GUARDIAN } from '@/config/app.config';
import { cn, clamp, formatBytes, formatRelative } from '@/lib/utils';
import { batteryBand, kioskBatteryTopic, type BatteryBand } from '@/services/kioskTelemetry';
import { useDeviceHealthStore } from '@/store/deviceHealthStore';
import { useHomeStore } from '@/store/homeStore';
import { getKioskId } from '@/utils/kioskIdentity';

/**
 * Salute del dispositivo: batteria, heap del browser, frame rate e latenza
 * verso il broker.
 *
 * È il pannello che si apre quando il tablet "ogni tanto rallenta": la batteria
 * dice se la fascia 20-80% sta funzionando, l'heap dice se il browser è al
 * limite dopo settimane di esecuzione continua, la latenza dice se il problema
 * è la rete. Touch-friendly: barre alte, numeri grandi, nessun hover obbligatorio.
 */

const BAND_TEXT: Record<BatteryBand, string> = {
  ok: 'text-success',
  low: 'text-warning',
  high: 'text-warning',
};

const BAND_BAR: Record<BatteryBand, string> = {
  ok: 'bg-success',
  low: 'bg-warning',
  high: 'bg-warning',
};

export function DeviceHealthCard() {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const supported = useDeviceHealthStore((state) => state.supported);
  const level = useDeviceHealthStore((state) => state.level);
  const charging = useDeviceHealthStore((state) => state.charging);
  const chargingTimeSec = useDeviceHealthStore((state) => state.chargingTimeSec);
  const heap = useDeviceHealthStore((state) => state.heap);
  const heapRatio = useDeviceHealthStore((state) => state.heapRatio);
  const fps = useDeviceHealthStore((state) => state.fps);
  const sampledAt = useDeviceHealthStore((state) => state.sampledAt);
  const latencyMs = useHomeStore((state) => state.connection.latencyMs);
  const status = useHomeStore((state) => state.connection.status);

  const band = batteryBand(level);
  const BatteryIcon = charging ? BatteryCharging : level < BATTERY_GUARDIAN.protectMinPercent ? BatteryLow : Battery;
  const heapCritical = heapRatio !== null && heapRatio > BATTERY_GUARDIAN.heapWarnRatio;
  const chargingEtaMinutes =
    charging && chargingTimeSec > 0 ? Math.max(1, Math.round(chargingTimeSec / 60)) : null;

  return (
    <Card data-testid="device-health-card">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <HeartPulse className="size-4 text-accent" /> {t('health.title')}
          </CardTitle>
          <CardDescription className="mt-1">{t('health.description')}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge
            variant={supported ? 'accent' : 'warning'}
            data-testid="battery-api-badge"
            title={supported ? t('health.api.supportedHint') : t('health.api.unsupportedHint')}
          >
            {supported ? t('health.api.supported') : t('health.api.unsupported')}
          </Badge>
          <Badge variant="neutral">{tCommon(`connection.status.${status}`)}</Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {/* Batteria: barra con fascia di protezione 20-80%. */}
        <div className="rounded-xl border border-line bg-panel-2 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-xs font-medium text-fg">
              <BatteryIcon
                className={cn('size-4', supported ? BAND_TEXT[band] : 'text-fg-subtle')}
                aria-hidden
              />
              {t('health.battery.title')}
            </span>
            <span
              className={cn('tabular text-base font-semibold', supported ? BAND_TEXT[band] : 'text-fg-subtle')}
              data-testid="battery-level"
              data-band={supported ? band : 'unsupported'}
            >
              {supported ? `${level}%` : t('health.unavailable')}
            </span>
          </div>

          <div
            role="progressbar"
            aria-label={t('health.battery.title')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={supported ? level : 0}
            data-testid="battery-bar"
            data-band={supported ? band : 'unsupported'}
            className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-elevated"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-500',
                supported ? BAND_BAR[band] : 'bg-elevated',
              )}
              style={{ width: `${supported ? clamp(level, 0, 100) : 0}%` }}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-fg-subtle">
            <span data-testid="battery-state">
              {!supported
                ? t('health.api.unsupportedHint')
                : charging
                  ? t('health.battery.charging')
                  : t('health.battery.discharging')}
            </span>
            <span>
              {supported && chargingEtaMinutes !== null
                ? t('health.battery.chargingEta', { minutes: chargingEtaMinutes })
                : supported
                  ? t(`health.battery.band.${band}`)
                  : null}
            </span>
          </div>
        </div>

        {/* Heap del browser: il segnale più affidabile di degrado dopo settimane H24. */}
        <div className="rounded-xl border border-line bg-panel-2 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-xs font-medium text-fg">
              <Cpu className="size-4 text-accent" aria-hidden /> {t('health.memory.title')}
            </span>
            <span
              className={cn('tabular text-xs', heapCritical ? 'text-warning' : 'text-fg-muted')}
              data-testid="heap-usage"
              data-band={heapRatio === null ? 'unsupported' : heapCritical ? 'warn' : 'ok'}
            >
              {heap
                ? t('health.memory.used', {
                    used: formatBytes(heap.usedBytes),
                    total: formatBytes(heap.limitBytes),
                  })
                : t('health.unavailable')}
            </span>
          </div>
          <div
            className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-elevated"
            data-testid="heap-bar"
            data-band={heapRatio === null ? 'unsupported' : heapCritical ? 'warn' : 'ok'}
          >
            <div
              className={cn('h-full rounded-full', heapCritical ? 'bg-warning' : 'bg-accent')}
              style={{ width: `${heapRatio === null ? 0 : Math.round(heapRatio * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-fg-subtle">
            {heapRatio === null ? t('health.memory.unavailableHint') : t('health.memory.hint')}
          </p>
        </div>

        {/* Rete e fluidità: dove guardare quando il pannello sembra lento. */}
        <div className="grid grid-cols-2 gap-2 text-[10px] text-fg-subtle">
          <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
            <Wifi className="mr-1 inline size-3" aria-hidden />
            {t('health.network.latency')}:{' '}
            <strong className="tabular text-fg-muted" data-testid="health-latency">
              {latencyMs === null ? tCommon('connection.latencyEmpty') : `${latencyMs} ms`}
            </strong>
          </span>
          <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
            <Activity className="mr-1 inline size-3" aria-hidden />
            {t('health.network.fps')}:{' '}
            <strong
              className={cn(
                'tabular',
                fps !== null && fps < BATTERY_GUARDIAN.minHealthyFps ? 'text-warning' : 'text-fg-muted',
              )}
              data-testid="health-fps"
            >
              {fps === null ? t('health.unavailable') : `${fps} fps`}
            </strong>
          </span>
        </div>

        <p
          className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-[10px] leading-relaxed text-fg-subtle"
          data-testid="health-telemetry-note"
        >
          {t('health.telemetry.note', {
            topic: kioskBatteryTopic(getKioskId()),
            seconds: Math.round(BATTERY_GUARDIAN.publishIntervalMs / 1_000),
          })}
        </p>
        <p className="text-[10px] text-fg-subtle" data-testid="health-sampled-at">
          {t('health.sampledAt', { when: formatRelative(sampledAt) })}
        </p>
      </CardContent>
    </Card>
  );
}
