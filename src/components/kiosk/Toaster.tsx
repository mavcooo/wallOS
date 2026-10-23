import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useToastStore } from '@/store/toastStore';

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
} as const;

export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-5 left-1/2 z-[90] flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-2xl border bg-panel/95 p-3 shadow-2xl backdrop-blur',
              'animate-rise',
              toast.tone === 'success' && 'border-success/30',
              toast.tone === 'error' && 'border-danger/30',
              toast.tone === 'info' && 'border-line',
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                toast.tone === 'success' && 'text-success',
                toast.tone === 'error' && 'text-danger',
                toast.tone === 'info' && 'text-accent',
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{toast.title}</p>
              {toast.description ? (
                <p className="mt-0.5 text-xs text-fg-muted">{toast.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="rounded-md p-1 text-fg-subtle transition-colors hover:text-fg"
              aria-label={t('actions.closeNotification')}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
