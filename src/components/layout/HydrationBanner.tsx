import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { selectIsHydrating, useHomeStore } from '@/store/homeStore';

/**
 * Barra di stato del Safe Boot.
 *
 * Dopo un riavvio (blackout, refresh) il broker consegna i retained in raffica:
 * finché la casa non è dichiarata sincronizzata i widget sono bloccati e questa
 * barra spiega perché, con il numero di aggiornamenti già ricevuti. Non copre
 * nulla (niente overlay modale): la consultazione passiva resta possibile.
 */
export function HydrationBanner() {
  const { t } = useTranslation();
  const isHydrating = useHomeStore(selectIsHydrating);
  const retained = useHomeStore((state) => state.recovery.retainedMessagesReceived);

  if (!isHydrating) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="hydration-banner"
      className="flex shrink-0 items-center gap-2 border-b border-accent/25 bg-accent-soft px-4 py-2 text-[11px] font-medium text-accent lg:px-6"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      <span>{t('hydration.title')}</span>
      <span aria-hidden className="text-accent/50">
        ·
      </span>
      <span className="tabular text-accent/80">
        {retained > 0
          ? t('hydration.progress', { count: retained })
          : t('hydration.waiting')}
      </span>
      <span className="ml-auto hidden shrink-0 text-[10px] font-normal text-accent/70 sm:block">
        {t('hydration.hint')}
      </span>
    </div>
  );
}
