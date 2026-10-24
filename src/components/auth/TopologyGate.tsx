import { useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useTopologyQuery } from '@/hooks/useTopologyQuery';
import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
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
 * compilati. TanStack Query è l'unica fonte dei metadati: questa gate attende
 * la risposta, allinea la mappa realtime di Zustand e solo allora monta
 * MqttProvider, così le sottoscrizioni partono con l'elenco corretto.
 *
 * Se il backend non risponde, l'ultima topologia salvata può avviare il
 * pannello: viene reinserita nella cache Query e il flusso è identico.
 */
export function TopologyGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const syncDeviceStates = useHomeStore((state) => state.syncDeviceStates);
  const pushToast = useToastStore((state) => state.push);
  const queryClient = useQueryClient();
  const { data, isError, error, refetch, isFetching, cached } = useTopologyQuery();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!data) return;
    // Metadati → righe realtime: preserva quelle già aggiornate dal broker.
    syncDeviceStates(data.devices);
    // Un refetch può eliminare la stanza attiva (cambio profilo, CRUD admin).
    const { ui, setRoom } = useHomeStore.getState();
    if (data.rooms.length > 0 && !data.rooms.some((room) => room.id === ui.room)) {
      setRoom(data.rooms[0]?.id ?? ui.room);
    }
    setReady(true);
  }, [data, syncDeviceStates]);

  const startFromCache = () => {
    if (!cached) return;
    queryClient.setQueryData(TOPOLOGY_QUERY_KEY, cached.topology);
    pushToast({
      title: t('gate.cachedTitle'),
      description: t('gate.cachedDescription', { time: formatTime(new Date(cached.savedAt)) }),
      tone: 'info',
    });
  };

  if (ready && data) return <>{children}</>;

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

  // `isPending`, oppure dati arrivati ma mappa realtime non ancora allineata.
  return <StartupSplash />;
}
