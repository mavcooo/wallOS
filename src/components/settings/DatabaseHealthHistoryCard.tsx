import { AlertTriangle, Database, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDatabaseHealthHistory } from '@/hooks/useDatabaseHealth';
import { activeLocale } from '@/i18n';
import type { DatabaseCheckRecord, DatabaseCheckStatus } from '@/lib/healthApi';
import { cn, formatRelative, formatTime } from '@/lib/utils';
import { useDatabaseHealthStore } from '@/store/databaseHealthStore';

/** Colore semantico del badge: verde sano, giallo lento, rosso irraggiungibile. */
const STATUS_VARIANT: Record<DatabaseCheckStatus, 'success' | 'warning' | 'danger'> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
};

const STATUS_LABEL_KEY = {
  healthy: 'database.history.status.healthy',
  degraded: 'database.history.status.degraded',
  down: 'database.history.status.down',
} as const;

/** `HH:mm:ss - DD/MM`, come richiesto dal pannello touch (24 ore). */
function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = date.toLocaleDateString(activeLocale(), { day: '2-digit', month: '2-digit' });
  return `${formatTime(date)} - ${day}`;
}

function HistoryRow({ record }: { record: DatabaseCheckRecord }) {
  const { t } = useTranslation('settings');
  const checkedAt = new Date(record.checkedAt);

  return (
    <li
      className="flex flex-col gap-1.5 px-3 py-2.5"
      data-testid="database-history-row"
      title={
        Number.isNaN(checkedAt.getTime()) ? undefined : checkedAt.toLocaleString(activeLocale())
      }
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[record.status]}>{t(STATUS_LABEL_KEY[record.status])}</Badge>
          <span className="tabular text-[11px] text-fg-muted">
            {t('database.history.latency', { ms: record.latencyMs })}
          </span>
        </span>
        <span className="tabular shrink-0 text-[11px] text-fg-subtle">
          {formatCheckedAt(record.checkedAt)}
        </span>
      </div>
      {record.errorMessage ? (
        <p className="break-all text-[10px] leading-relaxed text-danger">
          {t('database.history.errorDetails', { message: record.errorMessage })}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Storico dei controlli di connettività verso PostgreSQL.
 *
 * Ogni esito di `checkDatabaseHealth()` (healthy / degraded / down) arriva con
 * timestamp e latenza. Durante un down il gateway non può leggere la tabella:
 * TanStack Query conserva l'ultimo elenco e qui compare un avviso esplicito,
 * invece di uno spinner infinito o di una lista vuota.
 */
export function DatabaseHealthHistoryCard() {
  const { t } = useTranslation('settings');
  const query = useDatabaseHealthHistory({ limit: 50 });
  const liveStatus = useDatabaseHealthStore((state) => state.status);
  const liveError = useDatabaseHealthStore((state) => state.error);
  const liveCheckedAt = useDatabaseHealthStore((state) => state.checkedAt);

  const records = query.data ?? [];
  const liveDown = liveStatus === 'down';
  // Se il monitor non ha ancora un timestamp, l'avviso usa l'ultimo record
  // salvato: un pannello appena aperto non deve dire “mai”.
  const lastSavedAt = liveCheckedAt ?? (records[0] ? Date.parse(records[0].checkedAt) : null);
  const alertMessage = liveDown
    ? records.length > 0
      ? t('database.history.offlineStale', { when: formatRelative(lastSavedAt) })
      : t('database.history.offlineEmpty')
    : query.isError
      ? t('database.history.error', { message: query.error?.message ?? '' })
      : null;

  return (
    <Card data-testid="database-history-card">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Database className="size-4 text-accent" aria-hidden /> {t('database.history.title')}
          </CardTitle>
          <CardDescription className="mt-1">
            {t('database.history.description')}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="neutral">
            {t('database.history.count', { count: records.length })}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label={t('database.history.refresh')}
          >
            <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} aria-hidden />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {alertMessage ? (
          <p
            role="alert"
            data-testid="database-history-alert"
            className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-[10px] leading-relaxed text-danger"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              {alertMessage}
              {liveDown && liveError ? (
                <span className="mt-1 block font-mono text-[9px] opacity-80">
                  {t('database.history.lastError', { code: liveError })}
                </span>
              ) : null}
            </span>
          </p>
        ) : null}

        <div className="max-h-72 overflow-y-auto rounded-xl border border-line bg-bg/60 kiosk-scroll">
          {query.isPending ? (
            <p
              className="flex items-center justify-center gap-2 p-4 text-center text-[11px] text-fg-subtle"
              data-testid="database-history-loading"
              aria-busy="true"
            >
              <RefreshCw className="size-3.5 animate-spin" aria-hidden />
              {t('database.history.loading')}
            </p>
          ) : records.length === 0 ? (
            <p
              className="p-4 text-center text-[11px] text-fg-subtle"
              data-testid="database-history-empty"
            >
              {query.isError
                ? t('database.history.error', { message: query.error?.message ?? '' })
                : t('database.history.empty')}
            </p>
          ) : (
            <ul
              className="divide-y divide-line/60"
              data-testid="database-history-list"
              aria-live="polite"
            >
              {records.map((record) => (
                <HistoryRow key={`${record.id}-${record.checkedAt}`} record={record} />
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
