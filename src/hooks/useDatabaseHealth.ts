import { useEffect, useRef, useState } from 'react';

import { HEALTH_MONITOR } from '@/config/app.config';
import i18n from '@/i18n';
import { fetchDatabaseHealth } from '@/lib/healthApi';
import {
  useDatabaseHealthStore,
  type DatabaseHealthSnapshot,
} from '@/store/databaseHealthStore';
import { useToastStore } from '@/store/toastStore';

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
    };
  }, [intervalMs, timeoutMs]);

  return state;
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
