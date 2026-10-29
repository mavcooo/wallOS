import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useToastStore } from '@/store/toastStore';

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: TriangleAlert,
} as const;

/**
 * Toast transitori (`info`/`warning`). Gli allarmi `critical` non passano di
 * qui: sono bloccanti e vivono in `CriticalAlertOverlay`.
 */
export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  const visible = toasts.filter((toast) => toast.priority !== 'critical');
  if (visible.length === 0) return null;

  return (
    // Su smartphone i toast salgono sopra la Bottom Navigation invece di
    // coprirla; da `md` tornano in basso come sul pannello a parete.
    <div
      className="pointer-events-none fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] left-1/2 z-[90] flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col gap-2 md:bottom-5"
      role="status"
      aria-live="polite"
    >
      {visible.map((toast) => {
        const kind = toast.tone ?? (toast.priority === 'warning' ? 'warning' : 'info');
        const Icon = ICONS[kind];
        return (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-2xl border bg-panel/95 p-3 shadow-2xl backdrop-blur',
              'animate-rise',
              kind === 'success' && 'border-success/30',
              kind === 'error' && 'border-danger/30',
              kind === 'warning' && 'border-warning/40',
              kind === 'info' && 'border-line',
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                kind === 'success' && 'text-success',
                kind === 'error' && 'text-danger',
                kind === 'warning' && 'text-warning',
                kind === 'info' && 'text-accent',
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
