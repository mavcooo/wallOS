import { RotateCw, ShieldAlert, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useEmergencyReloadStore } from '@/store/emergencyReloadStore';
import { useHomeStore } from '@/store/homeStore';

/** Evento con cui la modale chiede al dimmer kiosk di risvegliarsi. */
export const KIOSK_WAKE_EVENT = 'domus:kiosk-wake';

/**
 * Modale di emergenza quando il blackout di rete supera i 10 minuti.
 *
 * Non serve a chiedere conferma: serve a **informare** l'utente presente che
 * il pannello sta per riavviarsi, dandogli però due uscite manuali (annulla il
 * riavvio, forza subito un tentativo). Il countdown è touch-friendly, ad alto
 * contrasto e con pulsanti grandi: pensata per un pannello a parete.
 *
 * Il risveglio del dimmer è voluto: se il pannello è in standby e scatta
 * l'avviso, l'utente deve vedere cosa sta per succedere. Invece, l'attività di
 * rete normale (heartbeat) non tocca mai il dimmer.
 */
export function EmergencyReloadModal() {
  const { t } = useTranslation();
  const reloadAt = useEmergencyReloadStore((state) => state.reloadAt);
  const remainingSeconds = useEmergencyReloadStore((state) => state.remainingSeconds);
  const blackoutSince = useEmergencyReloadStore((state) => state.blackoutSince);
  const cancelled = useEmergencyReloadStore((state) => state.cancelled);
  const cancelReload = useEmergencyReloadStore((state) => state.cancelReload);
  const retryHandler = useEmergencyReloadStore((state) => state.retryHandler);
  const frozen = useHomeStore((state) => state.connection.status === 'stale');

  const active = reloadAt !== null && !cancelled;

  // Il countdown è visibile: risveglia il dimmer kiosk per avvisare chi è
  // presente. Un solo evento, non un loop, così il pannello non resta acceso.
  useEffect(() => {
    if (!active) return;
    window.dispatchEvent(new Event(KIOSK_WAKE_EVENT));
  }, [active]);

  if (!active) return null;

  const minutes = blackoutSince === null ? null : Math.round((Date.now() - blackoutSince) / 60_000);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-labelledby="emergency-reload-title"
      data-testid="emergency-reload-modal"
      className="fixed inset-0 z-[95] flex flex-col bg-[#7c2d12] text-white"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-5 text-center sm:px-8">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-black/25 sm:size-20">
          <ShieldAlert
            className="size-10 animate-pulse motion-reduce:animate-none sm:size-12"
            aria-hidden="true"
          />
        </span>

        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.35em] text-white/85">
            {t('emergency.badge')}
          </p>
          <h1
            id="emergency-reload-title"
            className="mt-2 text-2xl font-bold leading-tight sm:text-3xl lg:text-4xl"
          >
            {t('emergency.title', {
              minutes: minutes ?? Math.round((Date.now() - (blackoutSince ?? Date.now())) / 60_000),
            })}
          </h1>
        </div>

        <p className="max-w-2xl text-base font-medium leading-snug text-white/95 sm:text-lg">
          {t('emergency.description')}
        </p>

        <div className="flex flex-col items-center gap-2">
          <span className="text-sm font-semibold uppercase tracking-wider text-white/80">
            {t('emergency.countdownLabel')}
          </span>
          <span
            data-testid="emergency-countdown"
            className="tabular text-6xl font-bold leading-none text-white sm:text-7xl"
            aria-live="polite"
          >
            {remainingSeconds ?? 0}
          </span>
        </div>

        {frozen ? (
          <p className="text-xs font-medium text-white/75">{t('emergency.frozenHint')}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-white/25 bg-black/25 p-4 sm:flex-row lg:px-12 lg:py-5">
        <button
          type="button"
          onClick={cancelReload}
          className="flex min-h-16 flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-white/60 px-5 text-base font-semibold text-white transition-colors active:bg-white/15"
        >
          <X className="size-5" aria-hidden="true" />
          {t('emergency.cancelReload')}
        </button>
        <button
          type="button"
          onClick={() => retryHandler?.()}
          className="flex min-h-16 flex-1 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-base font-bold text-[#7c2d12] transition-transform active:scale-[0.99]"
        >
          <RotateCw className="size-5" aria-hidden="true" />
          {t('emergency.retryNow')}
        </button>
      </div>
    </div>
  );
}
