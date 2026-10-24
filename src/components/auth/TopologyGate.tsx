import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useTopologyQuery } from '@/hooks/useTopologyQuery';
import { formatTime } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';

function StartupSplash() {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div>
        <p className="text-2xl font-semibold tracking-[0.35em] text-fg">{t('app.name')}</p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-fg-subtle">
          {t('app.tagline')}
        </p>
      </div>
      <Loader2 className="size-6 animate-spin text-accent" aria-hidden />
      <p className="text-[11px] uppercase tracking-wider text-fg-subtle">
        {t('gate.topologyLoading')}
      </p>
    </div>
  );
}

/**
 * La casa arriva dal gateway (PostgreSQL via `GET /api/topology`), non da file
 * compilati. TanStack Query gestisce cache, retry e stato; questa gate idrata
 * lo store solo a risposta valida e, se il backend non risponde, offre il
 * retry oppure l'avvio con l'ultima topologia salvata sul dispositivo.
 *
 * MqttProvider è montato solo dopo l'idratazione: le sottoscrizioni ai topic
 * dei device partono quindi già con l'elenco corretto.
 */
export function TopologyGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const status = useHomeStore((state) => state.topologyStatus);
  const hydrateTopology = useHomeStore((state) => state.hydrateTopology);
  const pushToast = useToastStore((state) => state.push);
  const { data, isError, error, refetch, isFetching, cached } = useTopologyQuery();

  useEffect(() => {
    if (data) hydrateTopology(data);
  }, [data, hydrateTopology]);

  const startFromCache = () => {
    if (!cached) return;
    hydrateTopology(cached.topology);
    pushToast({
      title: t('gate.cachedTitle'),
      description: t('gate.cachedDescription', { time: formatTime(new Date(cached.savedAt)) }),
      tone: 'info',
    });
  };

  // Già idratata (query precedente, cache o test): nessuno splash superfluo.
  if (status === 'ready') return <>{children}</>;

  if (isError) {
    const message = error instanceof Error ? error.message : t('gate.topologyError');

    return (
      <div
        className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 text-center"
        role="alert"
      >
        <span className="flex size-12 items-center justify-center rounded-2xl border border-danger/30 bg-danger/10 text-danger">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <p className="text-sm font-medium text-fg">{t('gate.topologyError')}</p>
        <p className="max-w-sm text-xs leading-relaxed text-fg-subtle">{message}</p>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex h-11 items-center gap-2 rounded-xl border border-line px-4 text-xs font-medium text-fg-muted transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"
          >
            {isFetching ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-4" aria-hidden />
            )}
            {t('actions.retry')}
          </button>

          {cached ? (
            <button
              type="button"
              onClick={startFromCache}
              className="h-11 rounded-xl border border-accent/40 bg-accent-soft px-4 text-xs font-medium text-accent transition-colors hover:bg-accent/15"
            >
              {t('gate.useCache')}
            </button>
          ) : null}
        </div>

        {cached ? (
          <p className="max-w-sm text-[10px] leading-relaxed text-fg-subtle">
            {t('gate.cacheHint', { time: formatTime(new Date(cached.savedAt)) })}
          </p>
        ) : null}
      </div>
    );
  }

  // `isPending`, oppure dati arrivati ma store non ancora idratato dall'effect.
  return <StartupSplash />;
}
