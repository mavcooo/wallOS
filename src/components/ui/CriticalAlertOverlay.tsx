import { Check, Droplets, Flame, ShieldAlert, TriangleAlert, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { formatTime } from '@/lib/utils';
import { useToastStore, type ToastMessage } from '@/store/toastStore';
import { audioAlert, bindAudioUnlockOnFirstGesture } from '@/utils/audioAlert';

type AlarmKind = 'smoke' | 'flood' | 'intrusion' | 'connection' | 'generic';

const ALARM_ICONS = {
  smoke: Flame,
  flood: Droplets,
  intrusion: ShieldAlert,
  connection: WifiOff,
  generic: TriangleAlert,
} as const;

function alarmKind(toast: ToastMessage): AlarmKind {
  const type = toast.metadata?.['type'];
  return type === 'smoke' || type === 'flood' || type === 'intrusion' || type === 'connection'
    ? type
    : 'generic';
}

/**
 * Overlay di emergenza per gli allarmi `critical`.
 *
 * - copre l'intera UI (sopra il dimmer kiosk) con fondo rosso ad alto contrasto,
 *   pensato per essere letto a diversi metri dal tablet;
 * - la sirena gira finché non viene tacitata o l'allarme riconosciuto;
 * - "Riconosci e chiudi" passa dal PinProvider condiviso quando l'allarme
 *   richiede privilegi autorizzati.
 */
export function CriticalAlertOverlay() {
  const { t } = useTranslation();
  const criticals = useToastStore(
    useShallow((state) => state.toasts.filter((toast) => toast.priority === 'critical')),
  );
  const silenced = useToastStore((state) => state.alarmSilenced);
  const silenceAlarm = useToastStore((state) => state.silenceAlarm);
  const acknowledgeCritical = useToastStore((state) => state.acknowledgeCritical);
  const requestPin = usePinGuard();

  const active = criticals[0];

  useEffect(() => {
    bindAudioUnlockOnFirstGesture();
  }, []);

  // Una sola sirena per tutti gli allarmi: il pattern riparte quando cambia
  // l'allarme in primo piano, si ferma quando viene tacitato o riconosciuto.
  useEffect(() => {
    if (!active || silenced) {
      audioAlert.stopAlarm();
      return;
    }
    audioAlert.playAlarm('siren');
    return () => audioAlert.stopAlarm();
  }, [active, silenced]);

  if (!active) return null;

  const kind = alarmKind(active);
  const Icon = ALARM_ICONS[kind];
  const others = criticals.slice(1);
  const triggeredAt = formatTime(new Date(active.timestamp));

  const acknowledge = () => {
    if (active.requirePin) {
      requestPin({
        title: t('alarm.pinTitle'),
        description: t('alarm.pinDescription', { title: active.title }),
        action: t('alarm.pinAction'),
        onConfirm: () => acknowledgeCritical(active.id),
      });
      return;
    }
    acknowledgeCritical(active.id);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-labelledby="critical-alert-title"
      data-testid="critical-alert-overlay"
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
              {t('alarm.badge')}
            </p>
            <h1
              id="critical-alert-title"
              className="mt-1 text-2xl font-bold leading-tight sm:text-3xl lg:text-5xl"
            >
              {active.title}
            </h1>
          </div>
        </div>

        {active.description ? (
          <p className="max-w-5xl text-base font-medium leading-snug text-white/95 sm:text-lg lg:text-2xl">
            {active.description}
          </p>
        ) : null}

        <ul className="flex flex-wrap gap-x-8 gap-y-1 text-sm text-white/90 lg:text-base">
          <li>{t(`alarm.types.${kind}`)}</li>
          <li>{t('alarm.since', { time: triggeredAt })}</li>
        </ul>

        {others.length > 0 ? (
          <div className="max-w-2xl rounded-2xl border border-white/30 bg-black/20 px-4 py-3">
            <p className="text-sm font-semibold">
              {t('alarm.others', { count: others.length })}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-white/85">
              {others.slice(0, 3).map((toast) => (
                <li key={toast.id}>· {toast.title}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-white/25 bg-black/25 p-4 sm:flex-row lg:px-12 lg:py-5">
        <button
          type="button"
          onClick={silenceAlarm}
          disabled={silenced}
          className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-white/60 px-5 text-base font-semibold text-white transition-colors active:bg-white/15 disabled:opacity-50"
        >
          {silenced ? (
            <VolumeX className="size-5" aria-hidden="true" />
          ) : (
            <Volume2 className="size-5" aria-hidden="true" />
          )}
          {silenced ? t('alarm.silenced') : t('alarm.silence')}
        </button>
        <button
          type="button"
          onClick={acknowledge}
          className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-base font-bold text-[#7f1d1d] transition-transform active:scale-[0.99]"
        >
          <Check className="size-5" aria-hidden="true" />
          {t('alarm.acknowledge')}
        </button>
      </div>
    </div>
  );
}
