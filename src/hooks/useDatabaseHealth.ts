import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { HEALTH_MONITOR } from '@/config/app.config';
import i18n from '@/i18n';
import {
  fetchDatabaseHealth,
  fetchDatabaseHealthHistory,
  type DatabaseCheckRecord,
} from '@/lib/healthApi';
import {
  useDatabaseHealthStore,
  type DatabaseHealthSnapshot,
} from '@/store/databaseHealthStore';
import { useToastStore } from '@/store/toastStore';

/** Dopo questo tempo di down il database diventa un allarme critico. */
const DATABASE_WATCHDOG_MS = 60_000;

/**
 * Monitoraggio periodico di `/api/health`.
 *
 * Notifica solo le transizioni: un toast quando il database cade e uno quando
 * torna disponibile. I tentativi successivi durante un down non generano altri
 * toast (niente raffiche), ma continuano a verificare il recupero.
 */
export function useDatabaseHealthMonitor(options?: {
  intervalMs?: number;
  timeoutMs?: number;
}): DatabaseHealthSnapshot {
  const intervalMs = options?.intervalMs ?? HEALTH_MONITOR.intervalMs;
  const timeoutMs = options?.timeoutMs ?? HEALTH_MONITOR.timeoutMs;

  const [state, setState] = useState<DatabaseHealthSnapshot>({
    status: 'checking',
    version: null,
    latencyMs: null,
    error: null,
    checkedAt: null,
  });
  const lastStatus = useRef<'up' | 'down' | null>(null);
  const downSince = useRef<number | null>(null);
  const watchdogAlertId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const controller = new AbortController();

    const check = async () => {
      const health = await fetchDatabaseHealth({ signal: controller.signal, timeoutMs });
      if (!active) return;

      const snapshot: DatabaseHealthSnapshot = {
        status: health.status,
        version: health.version,
        latencyMs: health.latencyMs,
        error: health.error,
        checkedAt: Date.now(),
      };
      setState(snapshot);
      // L'header legge lo stesso snapshot senza avviare un secondo polling.
      useDatabaseHealthStore.getState().setHealth(snapshot);

      // Watchdog: un down persistente non è un toast, è un allarme bloccante.
      const notifications = useToastStore.getState();
      if (health.status === 'down') {
        if (downSince.current === null) downSince.current = Date.now();
        if (
          !watchdogAlertId.current &&
          Date.now() - downSince.current >= DATABASE_WATCHDOG_MS
        ) {
          watchdogAlertId.current = notifications.addCritical({
            title: i18n.t('alarm.watchdog.databaseTitle'),
            description: i18n.t('alarm.watchdog.databaseDescription'),
            metadata: { type: 'connection', source: 'database' },
          });
        }
      } else {
        downSince.current = null;
        if (watchdogAlertId.current) {
          notifications.acknowledgeCritical(watchdogAlertId.current);
          watchdogAlertId.current = null;
        }
      }

      const toast = useToastStore.getState().push;
      if (health.status === 'down' && lastStatus.current !== 'down') {
        toast({
          title: i18n.t('database.toast.downTitle'),
          description: i18n.t('database.toast.downDescription', {
            reason: errorLabel(health.error),
          }),
          tone: 'error',
        });
      } else if (health.status === 'up' && lastStatus.current === 'down') {
        toast({
          title: i18n.t('database.toast.upTitle'),
          description: i18n.t('database.toast.upDescription', {
            version: health.version
              ? i18n.t('database.toast.upVersion', { version: health.version })
              : '',
          }),
          tone: 'success',
        });
      }
      lastStatus.current = health.status;

      if (active) {
        timer = window.setTimeout(() => void check(), intervalMs);
      }
    };

    void check();

    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      if (watchdogAlertId.current) {
        useToastStore.getState().acknowledgeCritical(watchdogAlertId.current);
        watchdogAlertId.current = null;
      }
    };
  }, [intervalMs, timeoutMs]);

  return state;
}

/** Chiave dello storico: separata da `/api/health`, che non usa TanStack Query. */
export const DATABASE_HISTORY_QUERY_KEY = ['database', 'history'] as const;

/**
 * Storico dei controlli di connettività dal gateway.
 *
 * - refetch ogni 30 s, come il monitor di `/api/health`: la diagnostica resta
 *   aggiornata senza un secondo polling scritto a mano;
 * - `staleTime` breve, così aprire le Impostazioni mostra subito un dato
 *   recente invece di aspettare il prossimo intervallo;
 * - in caso di errore TanStack conserva l'ultimo `data`: durante un down il
 *   pannello mostra lo storico salvato e un avviso, senza svuotarsi.
 */
export function useDatabaseHealthHistory(options?: {
  limit?: number;
  intervalMs?: number;
}): UseQueryResult<DatabaseCheckRecord[], Error> {
  const limit = options?.limit ?? 50;

  return useQuery({
    queryKey: [...DATABASE_HISTORY_QUERY_KEY, limit],
    queryFn: ({ signal }) => fetchDatabaseHealthHistory({ limit, signal }),
    refetchInterval: options?.intervalMs ?? 30_000,
    staleTime: 10_000,
    // Un solo retry immediato: il polling riprova comunque fra 30 s e il
    // pannello non deve restare in attesa di un backoff lungo.
    retry: 1,
    retryDelay: 0,
  });
}

function errorLabel(code: string | null): string {
  switch (code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
      return i18n.t('database.errors.gatewayDown');
    case '28P01':
    case '28000':
      return i18n.t('database.errors.authRejected');
    case '3D000':
      return i18n.t('database.errors.missingDatabase');
    case 'TIMEOUT':
      return i18n.t('database.errors.timeout');
    case 'NETWORK':
      return i18n.t('database.errors.network');
    default:
      return code
        ? i18n.t('database.errors.coded', { code })
        : i18n.t('database.errors.generic');
  }
}
