import { Loader2, TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useHomeStore } from '@/store/homeStore';

/**
 * La casa arriva da PostgreSQL, non da file compilati: nessuna vista viene
 * montata prima che `GET /api/topology` abbia restituito stanze, dispositivi
 * e scenari. In errore la UI resta esplicita e offre un retry.
 */
export function TopologyGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const status = useHomeStore((state) => state.topologyStatus);
  const error = useHomeStore((state) => state.topologyError);
  const loadTopology = useHomeStore((state) => state.loadTopology);

  useEffect(() => {
    void loadTopology();
  }, [loadTopology]);

  if (status === 'ready') return <>{children}</>;

  if (status === 'error') {
    return (
      <div
        className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 text-center"
        role="alert"
      >
        <span className="flex size-12 items-center justify-center rounded-2xl border border-danger/30 bg-danger/10 text-danger">
          <TriangleAlert className="size-5" />
        </span>
        <p className="text-sm font-medium text-fg">{t('gate.topologyError')}</p>
        <p className="max-w-sm text-xs leading-relaxed text-fg-subtle">{error}</p>
        <button
          type="button"
          onClick={() => void loadTopology()}
          className="mt-1 h-10 rounded-xl border border-line px-4 text-xs font-medium text-fg-muted transition-colors hover:bg-panel-2 hover:text-fg"
        >
          {t('actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg text-fg-subtle"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-5 animate-spin text-accent" />
      <p className="text-[11px] uppercase tracking-wider">{t('gate.topologyLoading')}</p>
    </div>
  );
}
