import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Database,
  KeyRound,
  Monitor,
  RefreshCw,
  Send,
  Trash2,
  Wifi,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { KIOSK_DEFAULTS } from '@/config/app.config';
import { BURN_IN_INTERVAL_OPTIONS, BURN_IN_LIMITS } from '@/lib/burnIn';
import { ADAPTERS } from '@/mqtt/adapters';
import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn, formatTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import { isPinLengthValid } from '@/lib/pin';
import type { BrokerSettings } from '@/types/mqtt';

const TIMEOUT_OPTIONS = [
  { value: 60_000, label: '1 min' },
  { value: 120_000, label: '2 min' },
  { value: 300_000, label: '5 min' },
  { value: 600_000, label: '10 min' },
] as const;

const BURN_IN_MODE_OPTIONS = [
  { value: 'screensaver-float', label: 'Orologio flottante', hint: 'Salti in punti casuali' },
  { value: 'subtle-shift', label: 'Micro-shift', hint: 'Oscilla di 1-4 px' },
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
  const broker = useHomeStore((state) => state.broker);
  const updateBroker = useHomeStore((state) => state.updateBroker);
  const connection = useHomeStore((state) => state.connection);
  const rawLog = useHomeStore((state) => state.rawLog);
  const clearRaw = useHomeStore((state) => state.clearRaw);
  const dimmerTimeoutMs = useHomeStore((state) => state.ui.dimmerTimeoutMs);
  const setDimmerTimeout = useHomeStore((state) => state.setDimmerTimeout);
  const burnIn = useHomeStore((state) => state.burnIn);
  const setBurnInSettings = useHomeStore((state) => state.setBurnInSettings);
  const setPin = useHomeStore((state) => state.setPin);
  const { publishRaw, reconnect } = useMqttApi();
  const requestPin = usePinGuard();
  const pushToast = useToastStore((state) => state.push);

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
      pushToast({ title: 'Configurazione non valida', description: 'Host e porta sono obbligatori.', tone: 'error' });
      return;
    }
    updateBroker(draft);
    pushToast({
      title: 'Broker aggiornato',
      description: 'Riconnessione in corso con i nuovi parametri.',
      tone: 'success',
    });
  };

  const regenerateClientId = () => {
    const clientId = `domus-kiosk-${Math.random().toString(36).slice(2, 8)}`;
    patch({ clientId });
  };

  const changePin = () => {
    if (!isPinLengthValid(newPin)) {
      setPinError('Il PIN deve contenere da 4 a 6 cifre.');
      return;
    }
    if (newPin !== confirmPin) {
      setPinError('I due PIN non coincidono.');
      return;
    }
    setPinError(null);
    requestPin({
      title: 'Conferma PIN attuale',
      description: 'Verifica il codice corrente prima di impostarne uno nuovo.',
      onConfirm: () => {
        void setPin(newPin).then(() => {
          setNewPin('');
          setConfirmPin('');
          pushToast({ title: 'PIN aggiornato', tone: 'success' });
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
                <Wifi className="size-4 text-accent" /> Broker MQTT
              </CardTitle>
              <CardDescription className="mt-1">
                Connessione WebSocket in LAN · parametri applicati al pannello
              </CardDescription>
            </div>
            <Badge variant={dirty ? 'warning' : 'success'}>
              {dirty ? 'Modifiche non salvate' : 'Allineato'}
            </Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="col-span-2">
                <Field label="Host / IP broker">
                  <Input
                    aria-label="Host / IP broker"
                    value={draft.host}
                    onChange={(event) => patch({ host: event.target.value })}
                    placeholder="192.168.1.10"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Field label="Porta WS">
                <Input
                  aria-label="Porta WS"
                  type="number"
                  inputMode="numeric"
                  value={draft.port}
                  onChange={(event) => patch({ port: Number(event.target.value) })}
                />
              </Field>
              <Field label="Path">
                <Input
                  aria-label="Path"
                  value={draft.path}
                  onChange={(event) => patch({ path: event.target.value })}
                  placeholder="/mqtt"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Field label="Protocollo">
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
              <Field label="KeepAlive (s)">
                <Input
                  aria-label="KeepAlive (s)"
                  type="number"
                  inputMode="numeric"
                  value={draft.keepAlive}
                  onChange={(event) => patch({ keepAlive: Number(event.target.value) })}
                />
              </Field>
              <div className="col-span-2">
                <Field label="Client ID" hint="Deve essere univoco sul broker.">
                  <div className="flex gap-2">
                    <Input
                      aria-label="Client ID"
                      value={draft.clientId}
                      onChange={(event) => patch({ clientId: event.target.value })}
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={regenerateClientId}
                      aria-label="Genera nuovo Client ID"
                    >
                      <RefreshCw className="size-4" />
                    </Button>
                  </div>
                </Field>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <Field label="Username (opzionale)">
                <Input
                  aria-label="Username (opzionale)"
                  value={draft.username}
                  onChange={(event) => patch({ username: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Password (opzionale)">
                <Input
                  aria-label="Password (opzionale)"
                  type="password"
                  value={draft.password}
                  onChange={(event) => patch({ password: event.target.value })}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Base topic (opzionale)" hint="Prefisso applicato a tutti i topic.">
                <Input
                  aria-label="Base topic (opzionale)"
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
                  aria-label="Modalità demo"
                />
                <div>
                  <p className="text-xs font-medium text-fg">Modalità demo</p>
                  <p className="text-[10px] text-fg-subtle">
                    Simula i dispositivi senza aprire socket verso il broker.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="default" onClick={reconnect}>
                  <RefreshCw className="size-4" /> Riconnetti
                </Button>
                <Button variant="primary" onClick={saveBroker} disabled={!dirty}>
                  <Check className="size-4" /> Salva e applica
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10px] text-fg-subtle sm:grid-cols-4">
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                Stato: <strong className="text-fg-muted">{connection.status}</strong>
              </span>
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                Latenza:{' '}
                <strong className="text-fg-muted">
                  {connection.latencyMs === null ? '—' : `${connection.latencyMs} ms`}
                </strong>
              </span>
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                RX/TX:{' '}
                <strong className="text-fg-muted">
                  {connection.messagesIn}/{connection.messagesOut}
                </strong>
              </span>
              <span className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                Retry: <strong className="text-fg-muted">{connection.reconnectAttempts}</strong>
              </span>
            </div>
            {connection.lastError ? (
              <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[10px] text-danger">
                Ultimo errore: {connection.lastError}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* Kiosk + PIN */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Monitor className="size-4 text-accent" /> Kiosk
                </CardTitle>
                <CardDescription className="mt-1">Screensaver e protezione burn-in</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div>
                <Label>Timeout inattività</Label>
                <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                  {TIMEOUT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setDimmerTimeout(option.value)}
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
                <Label>Movimento anti burn-in</Label>
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
                      {option.label}
                      <span className="text-[9px] font-normal text-fg-subtle">{option.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label>Intervallo di spostamento</Label>
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
                      {Math.round(value / 1000)} s
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label>Opacità orologio in standby</Label>
                <div className="mt-1.5 flex items-center gap-3">
                  <Slider
                    value={[Math.round(burnIn.dimClockOpacity * 100)]}
                    min={Math.round(BURN_IN_LIMITS.minClockOpacity * 100)}
                    max={Math.round(BURN_IN_LIMITS.maxClockOpacity * 100)}
                    step={5}
                    onValueChange={(values) =>
                      setBurnInSettings({ dimClockOpacity: (values[0] ?? 30) / 100 })
                    }
                    aria-label="Opacità orologio in standby"
                  />
                  <span className="tabular w-10 shrink-0 text-right text-[11px] text-fg-muted">
                    {Math.round(burnIn.dimClockOpacity * 100)}%
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
                Fade {KIOSK_DEFAULTS.dimmerFadeMs} ms · orologio in sleep al{' '}
                {Math.round(burnIn.dimClockOpacity * 100)}% ·{' '}
                {burnIn.mode === 'screensaver-float'
                  ? 'orologio flottante'
                  : 'micro-shift della dashboard'}{' '}
                ogni {Math.round(burnIn.shiftIntervalMs / 1000)} s · scudo anti-tocco{' '}
                {KIOSK_DEFAULTS.wakeGuardMs} ms.
              </div>
              <button
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('domus:kiosk-sleep'));
                }}
                className="h-10 rounded-xl border border-line text-[11px] font-medium text-fg-muted transition-colors hover:text-fg"
              >
                Mostra anteprima screensaver
              </button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="size-4 text-accent" /> PIN pannello
                </CardTitle>
                <CardDescription className="mt-1">
                  Protegge carichi, reset e scenari critici
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Field label="Nuovo PIN (4-6 cifre)">
                <Input
                  aria-label="Nuovo PIN (4-6 cifre)"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={newPin}
                  onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ''))}
                  placeholder="••••"
                />
              </Field>
              <Field label="Conferma PIN">
                <Input
                  aria-label="Conferma PIN"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ''))}
                  placeholder="••••"
                />
              </Field>
              {pinError ? <p className="text-[10px] text-danger">{pinError}</p> : null}
              <Button variant="primary" onClick={changePin} className="w-full">
                Aggiorna PIN
              </Button>
              <p className="text-[10px] leading-relaxed text-fg-subtle">
                Il PIN è memorizzato solo come hash SHA-256 nel dispositivo. In produzione la
                verifica va comunque replicata lato gateway.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Test topic */}
      <Card>
        <CardHeader className="flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4 text-accent" /> Test topic · monitor RAW
            </CardTitle>
            <CardDescription className="mt-1">
              Ultimi {rawLog.length} messaggi · in/out dal client MQTT
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Topic di test"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              className="h-9 w-40 text-xs"
              placeholder="topic"
              spellCheck={false}
            />
            <Input
              aria-label="Payload di test"
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
                pushToast({ title: 'Pubblicato', description: topic, tone: 'info' });
              }}
            >
              <Send className="size-3.5" /> Pubblica
            </Button>
            <Button variant="ghost" size="sm" onClick={clearRaw}>
              <Trash2 className="size-3.5" /> Pulisci
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-64 overflow-y-auto rounded-xl border border-line bg-bg/60 kiosk-scroll">
            {rawLog.length === 0 ? (
              <p className="p-4 text-center text-[11px] text-fg-subtle">
                In attesa di messaggi… pubblica un test o attendi un telemetry update.
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
