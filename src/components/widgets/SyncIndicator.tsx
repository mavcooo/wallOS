import { CloudUpload } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Indicatore discreto mostrato mentre lo stato del widget è ottimistico:
 * il comando è in coda e attende la conferma del broker.
 */
export function SyncIndicator({ pending, className }: { pending?: boolean; className?: string }) {
  if (!pending) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-warning/30 bg-warning/10 p-1 text-warning',
        className,
      )}
      title="In attesa di sincronizzazione con il broker"
      aria-label="In attesa di sincronizzazione"
    >
      <CloudUpload className="size-2.5 animate-pulse" aria-hidden />
    </span>
  );
}
