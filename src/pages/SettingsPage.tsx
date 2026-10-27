import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Database,
  KeyRound,
  Monitor,
  RefreshCw,
  Send,
  Sun,
  Trash2,
  Wifi,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { DeviceHealthCard } from '@/components/settings/DeviceHealthCard';
import { KioskIdentityCard } from '@/components/settings/KioskIdentityCard';
import { useKioskQuery, useUpdateKiosk } from '@/hooks/useKioskProfile';
import { getKioskId } from '@/utils/kioskIdentity';
import { LanguageSwitcher } from '@/components/settings/LanguageSwitcher';
import { PerformanceModeCard } from '@/components/settings/PerformanceModeCard';
import { SunlightModeCard } from '@/components/settings/SunlightModeCard';
import { TopologyManager } from '@/components/settings/TopologyManager';
import { KIOSK_DEFAULTS } from '@/config/app.config';
import { BURN_IN_INTERVAL_OPTIONS, BURN_IN_LIMITS } from '@/lib/burnIn';
import { ADAPTERS } from '@/mqtt/adapters';
import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useScreenWakeLock } from '@/hooks/useScreenWakeLock';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn, formatTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useAuthStore } from '@/store/authStore';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type { BrokerSettings } from '@/types/mqtt';

const TIMEOUT_OPTIONS = [
  { value: 60_000, label: '1 min' },
  { value: 120_000, label: '2 min' },
  { value: 300_000, label: '5 min' },
  { value: 600_000, label: '10 min' },
] as const;

const SYNC_DEBOUNCE_OPTIONS = [0, 100, 300, 600, 1_000] as const;

const BURN_IN_MODE_OPTIONS = [
  {
    value: 'screensaver-float',
    labelKey: 'kiosk.modes.floating',
    hintKey: 'kiosk.modes.floatingHint',
  },
  { value: 'subtle-shift', labelKey: 'kiosk.modes.shift', hintKey: 'kiosk.modes.shiftHint' },
] as const;

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint ? <span className="text-[10px] leading-relaxed text-fg-subtle">{hint}</span> : null}
    </div>
  );
}

export function SettingsPage() {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const broker = useHomeStore((state) => state.broker);
  const updateBroker = useHomeStore((state) => state.updateBroker);
  const connection = useHomeStore((state) => state.connection);
  const rawLog = useHomeStore((state) => state.rawLog);
  const clearRaw = useHomeStore((state) => state.clearRaw);
  const dimmerTimeoutMs = useHomeStore((state) => state.ui.dimmerTimeoutMs);
  const setDimmerTimeout = useHomeStore((state) => state.setDimmerTimeout);
  // Il timeout del dimmer è anche un parametro del display: cambiarlo dal
  // pannello deve finire in PostgreSQL, altrimenti alla prima idratazione (o
  // dopo un riavvio) tornerebbe il valore centralizzato.
  const kioskId = getKioskId();
  const { data: kioskDisplay } = useKioskQuery(kioskId);
  const updateKiosk = useUpdateKiosk();

  const changeDimmerTimeout = (ms: number) => {
    setDimmerTimeout(ms);
    if (!kioskDisplay) return;
    updateKiosk.mutate({ id: kioskId, patch: { dimmerTimeoutSec: Math.round(ms / 1000) } });
  };
  const burnIn = useHomeStore((state) => state.burnIn);
  const setBurnInSettings = useHomeStore((state) => state.setBurnInSettings);
  const topologySync = useHomeStore((state) => state.topologySync);
  const setTopologySyncSettings = useHomeStore((state) => state.setTopologySyncSettings);
  const changePin = useAuthStore((state) => state.changePin);
  const elevated = useAuthStore((state) => state.elevated);
  const role = useAuthStore((state) => state.user?.role);
  const { publishRaw, reconnect } = useMqttApi();
  const requestPin = usePinGuard();
  const pushToast = useToastStore((state) => state.push);
  // Stato diagnostico: lo stesso hook vive a livello root in App.tsx, qui
  // serve solo la riga di stato per la verifica su tablet fisici.
  const wakeLock = useScreenWakeLock();

  const [draft, setDraft] = useState<BrokerSettings>(broker);
  const [topic, setTopic] = useState('domus/test');
  const [payload, setPayload] = useState('{"probe":true}');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(broker),
    [draft, broker],
  );

  const patch = (values: Partial<BrokerSettings>) => setDraft((current) => ({ ...current, ...values }));

  const saveBroker = () => {
    if (!draft.host.trim() || draft.port <= 0) {
      pushToast({
        title: t('broker.invalidTitle'),
        description: t('broker.invalidDescription'),
        tone: 'error',
      });
      return;
    }

    const apply = () => {
      updateBroker(draft);
      pushToast({
        title: t('broker.updatedTitle'),
        description: t('broker.updatedDescription'),
        tone: 'success',
      });
    };

    // Connessione e credenziali del broker sono un'azione sensibile: senza
    // elevazione PIN si apre l'unico PinProtectionDialog dell'app.
    if (!elevated) {
      requestPin({
        title: t('broker.pinTitle'),
        description: t('broker.pinDescription'),
        action: t('broker.pinAction'),
        onConfirm: apply,
      });
      return;
    }
    apply();
  };

  const regenerateClientId = () => {
    const clientId = `domus-kiosk-${Math.random().toString(36).slice(2, 8)}`;
    patch({ clientId });
  };

  const submitPinChange = () => {
    if (!/^\d{4,6}$/.test(newPin)) {
      setPinError(t('pin.errorLength'));
      return;
    }
    if (newPin !== confirmPin) {
      setPinError(t('pin.errorMismatch'));
      return;
    }
    setPinError(null);
    requestPin({
      title: t('pin.confirmTitle'),
      description: t('pin.confirmDescription'),
      onConfirm: () => {
        void changePin(newPin)
          .then(() => {
            setNewPin('');
            setConfirmPin('');
            pushToast({ title: t('pin.updatedTitle'), tone: 'success' });
          })
          .catch((error: unknown) => {
            setPinError(error instanceof Error ? error.message : t('pin.updateFailed'));
          });
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Broker */}
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Wifi className="size-4 text-accent" /> {t('broker.title')}
              </CardTitle>
              <CardDescription className="mt-1">{t('broker.description')}</CardDescription>
            </div>
            <Badge variant={dirty ? 'warning' : 'success'}>
              {dirty ? t('broker.dirty') : t('broker.aligned')}
            </Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="col-span-2">
                <Field label={t('broker.host')}>
                  <Input
                    aria-label={t('broker.host')}
                    value={draft.host}
                    onChange={(event) => patch({ host: event.target.value })}
                    placeholder="192.168.1.10"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Field label={t('broker.port')}>
                <Input
                  aria-label={t('broker.port')}
                  type="number"
                  inputMode="numeric"
                  value={draft.port}
                  onChange={(event) => patch({ port: Number(event.target.value) })}
                />
              </Field>
              <Field label={t('broker.path')}>
                <Input
                  aria-label={t('broker.path')}
                  value={draft.path}
                  onChange={(event) => patch({ path: event.target.value })}
                  placeholder="/mqtt"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Field label={t('broker.protocol')}>
                <div className="flex gap-1.5">
                  {(['ws', 'wss'] as const).map((protocol) => (
                    <button
                      key={protocol}
                      type="button"
                      onClick={() => patch({ protocol })}
                      className={cn(
                        'h-11 flex-1 rounded-xl border text-xs font-semibold uppercase transition-colors',
                        draft.protocol === protocol
                          ? 'border-accent/40 bg-accent-soft text-accent'
                          : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                      )}
                    >
                      {protocol}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={t('broker.keepAlive')}>
                <Input
                  aria-label={t('broker.keepAlive')}
                  type="number"
                  inputMode="numeric"
                  value={draft.keepAlive}
                  onChange={(event) => patch({ keepAlive: Number(event.target.value) })}
                />
              </Field>
              <div className="col-span-2">
                <Field label={t('broker.clientId')} hint={t('broker.clientIdHint')}>
                  <div className="flex gap-2">
                    <Input
                      aria-label={t('broker.clientId')}
                      value={draft.clientId}
                      onChange={(event) => patch({ clientId: event.target.value })}
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={regenerateClientId}
                      aria-label={t('broker.regenerateClientId')}
                    >
                      <RefreshCw className="size-4" />
                    </Button>
                  </div>
                </Field>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <Field label={t('broker.username')}>
                <Input
                  aria-label={t('broker.username')}
                  value={draft.username}
                  onChange={(event) => patch({ username: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label={t('broker.password')}>
                <Input
                  aria-label={t('broker.password')}
                  type="password"
                  value={draft.password}
                  onChange={(event) => patch({ password: event.target.value })}
                  autoComplete="new-password"
                />
              </Field>
              <Field label={t('broker.baseTopic')} hint={t('broker.baseTopicHint')}>
                <Input
                  aria-label={t('broker.baseTopic')}
                  value={draft.baseTopic}
                  onChange={(event) => patch({ baseTopic: event.target.value })}
                  placeholder="casa/"
                  spellCheck={false}
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <Switch
                  checked={draft.demoMode}
                  onCheckedChange={(demoMode) => patch({ demoMode })}
                  aria-label={t('broker.demoLabel')}
                />
                <div>
                  <p className="text-xs font-medium text-fg">{t('broker.demoLabel')}</p>
                  <p className="text-[10px] text-fg-subtle">{t('broker.demoHint')}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="default" onClick={reconnect}>
                  <RefreshCw className="size-4" /> {t('broker.reconnect')}
                </Button>
                <Button variant="primary" onClick={saveBroker} disabled={!dirty}>
                  <Check className="size-4" /> {t('broker.save')}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10px] text-fg-subtle sm:grid-cols-4">
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                {t('broker.status')}:{' '}
                <strong className="text-fg-muted">
                  {tCommon(`connection.status.${connection.status}`)}
                </strong>
              </span>
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                {t('broker.latency')}:{' '}
                <strong className="text-fg-muted">
                  {connection.latencyMs === null ? '—' : `${connection.latencyMs} ms`}
                </strong>
              </span>
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                {t('broker.counters')}:{' '}
                <strong className="text-fg-muted">
                  {connection.messagesIn}/{connection.messagesOut}
                </strong>
              </span>
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                {t('broker.retry')}:{' '}
                <strong className="text-fg-muted">{connection.reconnectAttempts}</strong>
              </span>
            </div>
            {connection.lastError ? (
              <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[10px] text-danger">
                {t('broker.lastError', { error: connection.lastError })}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* Sincronizzazione topologia (affianca il broker) */}
        <Card data-testid="topology-sync-card">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <RefreshCw className="size-4 text-accent" /> {t('sync.title')}
              </CardTitle>
              <CardDescription className="mt-1">{t('sync.description')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <Label>{t('sync.debounce')}</Label>
              <div className="mt-1.5 grid grid-cols-5 gap-1.5">
                {SYNC_DEBOUNCE_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={topologySync.debounceMs === value}
                    onClick={() => setTopologySyncSettings({ debounceMs: value })}
                    className={cn(
                      'h-10 rounded-xl border text-[11px] font-medium transition-colors',
                      topologySync.debounceMs === value
                        ? 'border-accent/40 bg-accent-soft text-accent'
                        : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                    )}
                  >
                    {value === 0
                      ? t('sync.immediate')
                      : value < 1_000
                        ? `${value} ms`
                        : `${value / 1_000} s`}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-fg-subtle">
                {t('sync.hint')}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Lingua + Kiosk + PIN */}
        <div className="flex flex-col gap-4">
          <LanguageSwitcher />
          <SunlightModeCard />
          <PerformanceModeCard />
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Monitor className="size-4 text-accent" /> {t('kiosk.title')}
                </CardTitle>
                <CardDescription className="mt-1">{t('kiosk.description')}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div>
                <Label>{t('kiosk.timeout')}</Label>
                <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                  {TIMEOUT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => changeDimmerTimeout(option.value)}
                      className={cn(
                        'h-10 rounded-xl border text-[11px] font-medium transition-colors',
                        dimmerTimeoutMs === option.value
                          ? 'border-accent/40 bg-accent-soft text-accent'
                          : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>{t('kiosk.burnInMode')}</Label>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {BURN_IN_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={burnIn.mode === option.value}
                      onClick={() => setBurnInSettings({ mode: option.value })}
                      className={cn(
                        'flex h-12 flex-col items-center justify-center gap-0.5 rounded-xl border text-[11px] font-medium transition-colors',
                        burnIn.mode === option.value
                          ? 'border-accent/40 bg-accent-soft text-accent'
                          : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                      )}
                    >
                      {t(option.labelKey)}
                      <span className="text-[9px] font-normal text-fg-subtle">
                        {t(option.hintKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label>{t('kiosk.interval')}</Label>
                <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                  {BURN_IN_INTERVAL_OPTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={burnIn.shiftIntervalMs === value}
                      onClick={() => setBurnInSettings({ shiftIntervalMs: value })}
                      className={cn(
                        'h-10 rounded-xl border text-[11px] font-medium transition-colors',
                        burnIn.shiftIntervalMs === value
                          ? 'border-accent/40 bg-accent-soft text-accent'
                          : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                      )}
                    >
                      {t('kiosk.seconds', { value: Math.round(value / 1000) })}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label>{t('kiosk.clockOpacity')}</Label>
                <div className="mt-1.5 flex items-center gap-3">
                  <Slider
                    value={[Math.round(burnIn.dimClockOpacity * 100)]}
                    min={Math.round(BURN_IN_LIMITS.minClockOpacity * 100)}
                    max={Math.round(BURN_IN_LIMITS.maxClockOpacity * 100)}
                    step={5}
                    onValueChange={(values) =>
                      setBurnInSettings({ dimClockOpacity: (values[0] ?? 30) / 100 })
                    }
                    aria-label={t('kiosk.clockOpacity')}
                  />
                  <span className="tabular w-10 shrink-0 text-right text-[11px] text-fg-muted">
                    {Math.round(burnIn.dimClockOpacity * 100)}%
                  </span>
                </div>
              </div>

              {/* Diagnostica Wake Lock: utile al debug su tablet fisici. */}
              <div
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel-2 px-3 py-2.5"
                data-testid="wake-lock-status"
              >
                <span className="flex items-center gap-2 text-[11px] font-medium text-fg-muted">
                  <Sun className="size-3.5 text-accent" aria-hidden /> {t('kiosk.wakeLockLabel')}
                </span>
                <Badge
                  variant={
                    wakeLock.error
                      ? 'danger'
                      : wakeLock.isActive
                        ? 'success'
                        : wakeLock.isSupported
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {wakeLock.error
                    ? t('kiosk.wakeLockError', { error: wakeLock.error.message })
                    : wakeLock.isActive
                      ? t('kiosk.wakeLockActive')
                      : wakeLock.isSupported
                        ? t('kiosk.wakeLockInactive')
                        : t('kiosk.wakeLockUnsupported')}
                </Badge>
              </div>

              <div className="rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
                {t('kiosk.summary', {
                  fade: KIOSK_DEFAULTS.dimmerFadeMs,
                  opacity: Math.round(burnIn.dimClockOpacity * 100),
                  mode: t(
                    burnIn.mode === 'screensaver-float'
                      ? 'kiosk.modeFloating'
                      : 'kiosk.modeShift',
                  ),
                  seconds: Math.round(burnIn.shiftIntervalMs / 1000),
                  guard: KIOSK_DEFAULTS.wakeGuardMs,
                })}
              </div>
              <button
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('domus:kiosk-sleep'));
                }}
                className="h-10 rounded-xl border border-line text-[11px] font-medium text-fg-muted transition-colors hover:text-fg"
              >
                {t('kiosk.preview')}
              </button>
            </CardContent>
          </Card>

          {/* Identità del pannello: il nome e il `kiosk_id` con cui questo
              tablet si registra e riceve la configurazione dall'amministratore. */}
          <KioskIdentityCard />

          {/* Diagnostica H24: batteria (fascia 20-80%), heap del browser,
              frame rate e latenza verso il broker. */}
          <DeviceHealthCard />

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="size-4 text-accent" /> {t('pin.title')}
                </CardTitle>
                <CardDescription className="mt-1">{t('pin.description')}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Field label={t('pin.newPin')}>
                <Input
                  aria-label={t('pin.newPin')}
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={newPin}
                  onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ''))}
                  placeholder="••••"
                />
              </Field>
              <Field label={t('pin.confirmPin')}>
                <Input
                  aria-label={t('pin.confirmPin')}
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ''))}
                  placeholder="••••"
                />
              </Field>
              {pinError ? <p className="text-[10px] text-danger">{pinError}</p> : null}
              <Button variant="primary" onClick={submitPinChange} className="w-full">
                {t('pin.submit')}
              </Button>
              <p className="text-[10px] leading-relaxed text-fg-subtle">{t('pin.note')}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {role === 'admin' ? <TopologyManager /> : null}

      {/* Test topic */}
      <Card>
        <CardHeader className="flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4 text-accent" /> {t('raw.title')}
            </CardTitle>
            <CardDescription className="mt-1">
              {t('raw.description', { count: rawLog.length })}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('raw.topic')}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              className="h-9 w-40 text-xs"
              placeholder="topic"
              spellCheck={false}
            />
            <Input
              aria-label={t('raw.payload')}
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              className="h-9 w-48 text-xs"
              placeholder="payload"
              spellCheck={false}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                publishRaw(topic, payload);
                pushToast({ title: t('raw.publishedTitle'), description: topic, tone: 'info' });
              }}
            >
              <Send className="size-3.5" /> {t('raw.publish')}
            </Button>
            <Button variant="ghost" size="sm" onClick={clearRaw}>
              <Trash2 className="size-3.5" /> {t('raw.clear')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-64 overflow-y-auto rounded-xl border border-line bg-bg/60 kiosk-scroll">
            {rawLog.length === 0 ? (
              <p className="p-4 text-center text-[11px] text-fg-subtle">
                {t('raw.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-line/60">
                {rawLog.slice(0, 80).map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-start gap-2.5 px-3 py-2 font-mono text-[10px] leading-relaxed"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded',
                        entry.direction === 'in' && 'bg-accent/10 text-accent',
                        entry.direction === 'out' && 'bg-warning/10 text-warning',
                        entry.direction === 'system' && 'bg-elevated text-fg-subtle',
                      )}
                    >
                      {entry.direction === 'in' ? (
                        <ArrowDownLeft className="size-3" />
                      ) : entry.direction === 'out' ? (
                        <ArrowUpRight className="size-3" />
                      ) : (
                        <RefreshCw className="size-2.5" />
                      )}
                    </span>
                    <span className="tabular shrink-0 text-fg-subtle">
                      {formatTime(new Date(entry.at))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-fg-muted">{entry.topic}</span>
                      <span className="block break-all text-fg-subtle">{entry.payload}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(ADAPTERS).map(([id, adapter]) => (
              <span
                key={id}
                className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[10px] text-fg-subtle"
              >
                {id} · {adapter.label}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
