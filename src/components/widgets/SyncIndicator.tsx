import { CloudUpload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * Indicatore discreto mostrato mentre lo stato del widget è ottimistico:
 * il comando è in coda e attende la conferma del broker.
 */
export function SyncIndicator({ pending, className }: { pending?: boolean; className?: string }) {
  const { t } = useTranslation();
  if (!pending) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-warning/30 bg-warning/10 p-1 text-warning',
        className,
      )}
      title={t('sync.title')}
      aria-label={t('sync.aria')}
    >
      <CloudUpload className="size-2.5 animate-pulse" aria-hidden />
    </span>
  );
}
