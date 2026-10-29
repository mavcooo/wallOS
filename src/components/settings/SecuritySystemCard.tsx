import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useSecurityActions } from '@/hooks/useSecurityActions';
import type { SecurityArmMode, SecurityStatus, SecurityZone } from '@/lib/securityApi';
import { formatTime } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useSecurityStore } from '@/store/securityStore';

const STATUS_VARIANT: Record<SecurityStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  DISARMED: 'neutral',
  ARMED_HOME: 'success',
  ARMED_AWAY: 'success',
  TRIGGERED: 'danger',
};

/**
 * Armamento dell'impianto e configurazione delle zone.
 *
 * - **Inserisci / Disinserisci** passano sempre dal `PinProtectionDialog`: il
 *   server accetta solo un PIN verificato (o una sessione già elevata), quindi
 *   il pannello non può disarmare l'antifurto con un semplice tocco. La risposta
 *   include gli allarmi aperti e i sensori non in riposo: se l'impianto rifiuta
 *   l'armamento (409 `ZONE_NOT_READY`) l'elenco dei blocchi finisce a schermo;
 * - **Zone** (policy HOME/AWAY e spostamento sensori) sono configurazione:
 *   visibili e modificabili solo dal profilo admin, come la topologia. La zona
 *   `emergency` resta sempre attiva e non espone toggle;
 * - i dati arrivano dallo `securityStore`, alimentato da `/api/security/state`
 *   e dallo stream SSE, quindi questa card si aggiorna anche se l'impianto
 *   viene armato da un altro tablet.
 */
export function SecuritySystemCard() {
  const { t } = useTranslation('settings');
  const snapshot = useSecurityStore((state) => state.snapshot);
  const role = useAuthStore((state) => state.user?.role);
  const requestPin = usePinGuard();
  const { arm, disarm, updateZone, assignSensorZone } = useSecurityActions();

  const isAdmin = role === 'admin';
  const status = snapshot?.state.status ?? 'DISARMED';
  const zones = snapshot?.zones ?? [];
  const openSensors = snapshot?.openSensors ?? [];
  const busy = arm.isPending || disarm.isPending || updateZone.isPending || assignSensorZone.isPending;
  const error = arm.error ?? disarm.error ?? updateZone.error ?? assignSensorZone.error;

  const runArm = (mode: SecurityArmMode) => {
    if (status === mode) return;
    requestPin({
      title: t('security.pinArmTitle'),
      description: t('security.pinArmDescription', { mode: t(`security.status.${mode}`) }),
      action: t('security.pinAction'),
      onConfirm: () => arm.mutate(mode),
    });
  };

  const runDisarm = () => {
    requestPin({
      title: t('security.pinDisarmTitle'),
      description: t('security.pinDisarmDescription'),
      action: t('security.pinAction'),
      onConfirm: () => disarm.mutate(),
    });
  };

  const moveSensor = (zoneId: string, deviceId: string) => {
    if (zoneId === '') return;
    assignSensorZone.mutate({ deviceId, zoneId });
  };

  const zoneOptions = zones.map((zone) => (
    <option key={zone.id} value={zone.id}>
      {zone.name}
    </option>
  ));

  return (
    <Card data-testid="security-system-card">
      <CardHeader className="flex-wrap">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-accent" aria-hidden /> {t('security.title')}
          </CardTitle>
          <CardDescription className="mt-1">{t('security.description')}</CardDescription>
        </div>
        <Badge variant={STATUS_VARIANT[status]} data-testid="security-status">
          {t(`security.status.${status}`)}
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant={status === 'ARMED_HOME' ? 'secondary' : 'outline'}
            onClick={() => runArm('ARMED_HOME')}
            disabled={busy || status === 'ARMED_HOME'}
          >
            <ShieldCheck className="size-4" aria-hidden /> {t('security.armHome')}
          </Button>
          <Button
            variant={status === 'ARMED_AWAY' ? 'secondary' : 'outline'}
            onClick={() => runArm('ARMED_AWAY')}
            disabled={busy || status === 'ARMED_AWAY'}
          >
            <ShieldCheck className="size-4" aria-hidden /> {t('security.armAway')}
          </Button>
          <Button
            variant="ghost"
            onClick={runDisarm}
            disabled={busy || status === 'DISARMED'}
            className="text-danger"
          >
            <ShieldOff className="size-4" aria-hidden /> {t('security.disarm')}
          </Button>
        </div>

        {snapshot?.state.armedAt ? (
          <p className="text-[10px] text-fg-subtle">
            {t('security.armedSince', {
              when: formatTime(new Date(snapshot.state.armedAt)),
            })}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-[11px] font-medium text-danger">
            {error instanceof Error ? error.message : String(error)}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <div>
            <p className="text-xs font-semibold text-fg">{t('security.zones.title')}</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-fg-subtle">
              {t('security.zones.description')}
            </p>
          </div>

          {zones.length === 0 ? (
            <p className="rounded-xl border border-line bg-panel-2/60 px-3 py-2 text-[11px] text-fg-subtle">
              {t('security.zones.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {zones.map((zone) => (
                <ZoneRow
                  key={zone.id}
                  zone={zone}
                  isAdmin={isAdmin}
                  busy={busy}
                  options={zoneOptions}
                  onToggle={(patch) => updateZone.mutate({ id: zone.id, patch })}
                  onMove={moveSensor}
                />
              ))}
            </ul>
          )}
        </div>

        {openSensors.length > 0 ? (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
              <ShieldAlert className="size-3.5" aria-hidden /> {t('security.openSensors.title')}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-[10px] text-fg-muted">
              {openSensors.map((sensor) => (
                <li key={sensor.deviceId}>
                  {sensor.name}
                  {sensor.roomName ? ` · ${sensor.roomName}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface ZoneRowProps {
  zone: SecurityZone;
  options: ReactNode;
  isAdmin: boolean;
  busy: boolean;
  onToggle(patch: { armHome?: boolean; armAway?: boolean }): void;
  onMove(zoneId: string, deviceId: string): void;
}

function ZoneRow({ zone, isAdmin, busy, options, onToggle, onMove }: ZoneRowProps) {
  const { t } = useTranslation('settings');
  const alwaysOn = zone.kind === 'emergency';

  return (
    <li className="rounded-xl border border-line bg-panel-2/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-fg">{zone.name}</p>
          <p className="text-[10px] text-fg-subtle">{t(`security.zones.kind.${zone.kind}`)}</p>
        </div>

        {alwaysOn ? (
          <Badge variant="warning">{t('security.zones.alwaysOn')}</Badge>
        ) : isAdmin ? (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              <Switch
                checked={zone.armHome}
                disabled={busy}
                onCheckedChange={(checked) => onToggle({ armHome: checked })}
                aria-label={t('security.zones.home', { name: zone.name })}
              />
              {t('security.zones.home')}
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              <Switch
                checked={zone.armAway}
                disabled={busy}
                onCheckedChange={(checked) => onToggle({ armAway: checked })}
                aria-label={t('security.zones.away', { name: zone.name })}
              />
              {t('security.zones.away')}
            </label>
          </div>
        ) : (
          <span className="text-[10px] text-fg-subtle">
            {[zone.armHome ? t('security.zones.home') : null, zone.armAway ? t('security.zones.away') : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>

      {zone.sensors.length === 0 ? (
        <p className="mt-2 text-[10px] text-fg-subtle">{t('security.zones.noSensors')}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {zone.sensors.map((sensor) => (
            <li
              key={sensor.deviceId}
              className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-muted"
            >
              <span className="min-w-0 truncate">
                {sensor.name}
                {sensor.roomName ? ` · ${sensor.roomName}` : ''}
              </span>
              {isAdmin ? (
                <select
                  value={zone.id}
                  disabled={busy}
                  aria-label={t('security.zones.move', { name: sensor.name })}
                  onChange={(event) => onMove(event.target.value, sensor.deviceId)}
                  className="h-8 rounded-lg border border-line bg-panel px-2 text-[11px] text-fg disabled:opacity-50"
                >
                  {options}
                </select>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
