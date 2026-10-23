import { Contrast, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useHighContrast } from '@/hooks/useHighContrast';
import { cn } from '@/lib/utils';

/**
 * Accesso rapido dal header: un tocco rovescia la modalità e la scelta resta
 * salvata. `aria-pressed` espone lo stato, l'etichetta descrive l'azione.
 */
export function ContrastToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { enabled, toggle } = useHighContrast();
  const label = enabled ? t('header.contrast.off') : t('header.contrast.on');

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-2xl border transition-colors',
        enabled
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-line text-fg-muted hover:bg-panel-2 hover:text-fg',
        className,
      )}
    >
      {enabled ? (
        <Sun className="size-4" aria-hidden />
      ) : (
        <Contrast className="size-4" aria-hidden />
      )}
    </button>
  );
}
