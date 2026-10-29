import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Droplets, Flame, ShieldAlert, TriangleAlert, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { SECURITY_QUERY_KEY } from '@/hooks/useSecuritySync';
import { securityApi } from '@/lib/securityApi';
import { formatTime } from '@/lib/utils';
import { selectActiveAlarms, useSecurityStore } from '@/store/securityStore';
import { useToastStore, type ToastMessage } from '@/store/toastStore';
import { audioAlert, bindAudioUnlockOnFirstGesture } from '@/utils/audioAlert';

type AlarmKind = 'smoke' | 'flood' | 'gas' | 'co' | 'intrusion' | 'generic';

const ALARM_ICONS = {
  smoke: Flame,
  flood: Droplets,
  gas: Flame,
  co: TriangleAlert,
  intrusion: ShieldAlert,
  generic: TriangleAlert,
} as const;

function alarmKind(eventType: string): AlarmKind {
  switch (eventType) {
    case 'smoke':
    case 'flood':
    case 'gas':
    case 'co':
      return eventType;
    case 'motion':
    case 'contact':
    case 'tamper':
    case 'intrusion':
      return 'intrusion';
    default:
      return 'generic';
  }
}

/**
 * Overlay di emergenza.
 *
 * Due sorgenti, in ordine di priorità:
 *
 * 1. **Allarmi di sicurezza persistiti** (`security_events` via
 *    `/api/security/state` e stream SSE). Non sono toast: chiudere il browser,
 *    riavviare il kiosk o ricaricare la pagina non porta via nulla, perché lo
 *    snapshot successivo contiene ancora gli eventi con `resolvedAt === null`.
 *    Le azioni sono deliberatamente separate:
 *    - **Tacita segnale sonoro**: ferma solo la Web Audio API di *questo*
 *      tablet; il server non sa nulla e l'evento resta aperto;
 *    - **Conferma allarme (ACK)**: passa dal `PinProvider`, scrive
 *      `acknowledged_at`/`acknowledged_by` e ferma la sirena, ma l'evento resta
 *      pendente finché la causa non rientra;
 *    - **Segna risolto**: chiude l'evento (`resolved_at`) e, se non resta nessun
 *      allarme, il server riporta l'impianto in `DISARMED`. Nulla viene
 *      cancellato: lo storico conserva tutto.
 *
 * 2. **Avvisi di sistema** (`critical` nello store dei toast: broker o database
 *    irraggiungibili da oltre un minuto). Non sono eventi di sicurezza e non
 *    stanno su PostgreSQL, ma restano bloccanti: senza broker il pannello non
 *    comanda più nulla, quindi vanno visti subito. Vengono mostrati solo quando
 *    non c'è un allarme di sicurezza attivo, che ha sempre la precedenza.
 */
export function CriticalAlertOverlay() {
  const { t } = useTranslation();
  const events = useSecurityStore(selectActiveAlarms);
  const systemAlerts = useToastStore(
    useShallow((state) => state.toasts.filter((toast) => toast.priority === 'critical')),
  );
  const systemSilenced = useToastStore((state) => state.alarmSilenced);
  const silenceSystemAlarm = useToastStore((state) => state.silenceAlarm);
  const acknowledgeCritical = useToastStore((state) => state.acknowledgeCritical);
  const requestPin = usePinGuard();
  const queryClient = useQueryClient();
  /** Evento di sicurezza la cui sirena è stata tacitata **localmente**. */
  const [silencedEventId, setSilencedEventId] = useState<string | null>(null);

  const active = events[0] ?? null;
  const systemAlert: ToastMessage | null = active ? null : (systemAlerts[0] ?? null);

  // La sirena suona per il primo allarme di sicurezza non ancora preso in
  // carico: se quello in primo piano è già riconosciuto, passa al successivo.
  const securitySiren =
    events.find((event) => event.acknowledgedAt === null && event.id !== silencedEventId)?.id ?? null;
  const sirenKey = securitySiren ?? (systemAlert && !systemSilenced ? `system:${systemAlert.id}` : null);

  useEffect(() => {
    bindAudioUnlockOnFirstGesture();
  }, []);

  // Una sola sirena per volta: il pattern riparte quando cambia l'allarme in
  // primo piano, si ferma quando viene tacitato o riconosciuto.
  useEffect(() => {
    if (!sirenKey) {
      audioAlert.stopAlarm();
      return;
    }
    audioAlert.playAlarm('siren');
    return () => audioAlert.stopAlarm();
  }, [sirenKey]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: SECURITY_QUERY_KEY });
  };

  const acknowledge = useMutation({
    mutationFn: (id: string) => securityApi.acknowledge(id),
    onSuccess: invalidate,
  });

  const resolve = useMutation({
    mutationFn: (id: string) => securityApi.resolve(id),
    onSuccess: invalidate,
  });

  // ── Avviso di sistema (broker/database) ────────────────────────────────────
  if (!active && systemAlert) {
    const SystemIcon = systemAlert.metadata?.['type'] === 'connection' ? WifiOff : TriangleAlert;
    const silence = () => {
      silenceSystemAlarm();
      audioAlert.stopAlarm();
    };
    const close = () => {
      if (systemAlert.requirePin) {
        requestPin({
          title: t('alarm.pinTitle'),
          description: t('alarm.pinDescription', { title: systemAlert.title }),
          action: t('alarm.pinAction'),
          onConfirm: () => acknowledgeCritical(systemAlert.id),
        });
        return;
      }
      acknowledgeCritical(systemAlert.id);
    };

    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
        aria-labelledby="critical-alert-title"
        data-testid="critical-alert-overlay"
        data-source="system"
        className="fixed inset-0 z-[96] flex flex-col bg-[#DC2626] text-white"
      >
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-5 px-5 py-8 sm:px-8 lg:px-12">
          <div className="flex items-start gap-4">
            <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-black/25 lg:size-20">
              <SystemIcon
                className="size-10 animate-pulse motion-reduce:animate-none lg:size-12"
                aria-hidden="true"
              />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.35em] text-white/85">
                {t('alarm.badge')}
              </p>
              <h1
                id="critical-alert-title"
                className="mt-1 text-2xl font-bold leading-tight sm:text-3xl lg:text-5xl"
              >
                {systemAlert.title}
              </h1>
            </div>
          </div>
          {systemAlert.description ? (
            <p className="max-w-5xl text-base font-medium leading-snug text-white/95 sm:text-lg lg:text-2xl">
              {systemAlert.description}
            </p>
          ) : null}
          <ul className="flex flex-wrap gap-x-8 gap-y-1 text-sm text-white/90 lg:text-base">
            <li>{t('alarm.types.connection')}</li>
            <li>{t('alarm.since', { time: formatTime(new Date(systemAlert.timestamp)) })}</li>
          </ul>
        </div>
        <div className="flex flex-col gap-3 border-t border-white/25 bg-black/25 p-4 sm:flex-row lg:px-12 lg:py-5">
          <button
            type="button"
            onClick={silence}
            disabled={systemSilenced}
            className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-white/60 px-5 text-base font-semibold text-white transition-colors active:bg-white/15 disabled:opacity-50"
          >
            {systemSilenced ? (
              <VolumeX className="size-5" aria-hidden="true" />
            ) : (
              <Volume2 className="size-5" aria-hidden="true" />
            )}
            {systemSilenced ? t('alarm.silenced') : t('alarm.silence')}
          </button>
          <button
            type="button"
            onClick={close}
            className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-base font-bold text-[#7f1d1d] transition-transform active:scale-[0.99]"
          >
            <Check className="size-5" aria-hidden="true" />
            {t('alarm.acknowledgeSystem')}
          </button>
        </div>
      </div>
    );
  }

  if (!active) return null;

  // ── Allarme di sicurezza persistito ───────────────────────────────────────
  const kind = alarmKind(active.eventType);
  const Icon = ALARM_ICONS[kind];
  const others = events.slice(1);
  const triggeredAt = formatTime(new Date(active.triggeredAt));
  const acknowledged = active.acknowledgedAt !== null;
  const audioSilenced = acknowledged || silencedEventId === active.id;
  const busy = acknowledge.isPending || resolve.isPending;
  const failure = acknowledge.error ?? resolve.error;

  const confirmAcknowledge = () => {
    requestPin({
      title: t('alarm.pinTitle'),
      description: t('alarm.pinDescription', { title: active.deviceName }),
      action: t('alarm.pinAction'),
      onConfirm: () => acknowledge.mutate(active.id),
    });
  };

  const confirmResolve = () => {
    requestPin({
      title: t('alarm.resolvePinTitle'),
      description: t('alarm.resolvePinDescription', { title: active.deviceName }),
      action: t('alarm.pinAction'),
      onConfirm: () => resolve.mutate(active.id),
    });
  };

  const silence = () => {
    setSilencedEventId(active.id);
    audioAlert.stopAlarm();
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-labelledby="critical-alert-title"
      data-testid="critical-alert-overlay"
      data-source="security"
      className="fixed inset-0 z-[96] flex flex-col bg-[#DC2626] text-white"
    >
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-5 px-5 py-8 sm:px-8 lg:px-12">
        <div className="flex items-start gap-4">
          <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-black/25 lg:size-20">
            <Icon
              className="size-10 animate-pulse motion-reduce:animate-none lg:size-12"
              aria-hidden="true"
            />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.35em] text-white/85">
              {acknowledged ? t('alarm.acknowledgedBadge') : t('alarm.badge')}
            </p>
            <h1
              id="critical-alert-title"
              className="mt-1 text-2xl font-bold leading-tight sm:text-3xl lg:text-5xl"
            >
              {t(`alarm.types.${kind}`)}
            </h1>
          </div>
        </div>

        <p className="max-w-5xl text-base font-medium leading-snug text-white/95 sm:text-lg lg:text-2xl">
          {[active.deviceName, active.roomName].filter(Boolean).join(' · ')}
        </p>

        <ul className="flex flex-wrap gap-x-8 gap-y-1 text-sm text-white/90 lg:text-base">
          <li>{t('alarm.since', { time: triggeredAt })}</li>
          {acknowledged ? (
            <li>
              {t('alarm.acknowledgedAt', {
                time: formatTime(new Date(active.acknowledgedAt ?? active.triggeredAt)),
              })}
            </li>
          ) : null}
        </ul>

        {others.length > 0 ? (
          <div className="max-w-2xl rounded-2xl border border-white/30 bg-black/20 px-4 py-3">
            <p className="text-sm font-semibold">
              {t('alarm.others', { count: others.length })}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-white/85">
              {others.slice(0, 3).map((event) => (
                <li key={event.id}>
                  · {t(`alarm.types.${alarmKind(event.eventType)}`)} —{' '}
                  {[event.deviceName, event.roomName].filter(Boolean).join(' · ')}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {failure ? (
          <p role="status" className="text-sm font-semibold text-white/95">
            {t('alarm.actionFailed', {
              message: failure instanceof Error ? failure.message : String(failure),
            })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-white/25 bg-black/25 p-4 sm:flex-row lg:px-12 lg:py-5">
        <button
          type="button"
          onClick={silence}
          disabled={audioSilenced}
          className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-white/60 px-5 text-base font-semibold text-white transition-colors active:bg-white/15 disabled:opacity-50"
        >
          {audioSilenced ? (
            <VolumeX className="size-5" aria-hidden="true" />
          ) : (
            <Volume2 className="size-5" aria-hidden="true" />
          )}
          {audioSilenced ? t('alarm.silenced') : t('alarm.silence')}
        </button>
        <button
          type="button"
          onClick={confirmAcknowledge}
          disabled={acknowledged || busy}
          className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-base font-bold text-[#7f1d1d] transition-transform active:scale-[0.99] disabled:opacity-60"
        >
          <Check className="size-5" aria-hidden="true" />
          {acknowledged ? t('alarm.acknowledged') : t('alarm.acknowledge')}
        </button>
        <button
          type="button"
          onClick={confirmResolve}
          disabled={busy}
          className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-white/60 px-5 text-base font-semibold text-white transition-colors active:bg-white/15 disabled:opacity-50"
        >
          {t('alarm.resolve')}
        </button>
      </div>
    </div>
  );
}
