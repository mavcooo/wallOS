import { History, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useSecurityActions,
  useSecurityHistory,
  type HistoryRange,
} from '@/hooks/useSecurityActions';
import { activeLocale } from '@/i18n';
import type { SecurityEventRecord, SecuritySeverity } from '@/lib/securityApi';
import { securityAlarmKind, securityLifecycle } from '@/lib/securityLabels';
import { cn } from '@/lib/utils';

const RANGES: readonly HistoryRange[] = ['24h', '7d', '30d', 'all'];
const SEVERITIES: readonly (SecuritySeverity | 'all')[] = ['all', 'critical', 'warning', 'info'];

const SEVERITY_VARIANT: Record<SecuritySeverity, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

const LIFECYCLE_VARIANT = {
  open: 'danger',
  acknowledged: 'warning',
  resolved: 'neutral',
} as const;

function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(activeLocale(), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Storico degli allarmi (`GET /api/security/history`).
 *
 * Gli eventi non vengono mai cancellati: un allarme risolto resta qui con
 * timbro di acknowledgment, timbro di rientro e nota scritta da chi è
 * intervenuto. I filtri temporali sono finestre relative calcolate sul server a
 * partire da `from` (ISO), così un tablet con l'orologio sfasato non sposta il
 * confine della query; la severità filtra a monte, in SQL.
 *
 * La risoluzione richiede il PIN e una nota facoltativa: è la stessa mutazione
 * usata dall'overlay (`POST /events/:id/resolve`), quindi lo stato live e lo
 * storico si aggiornano insieme.
 */
export function SecurityHistoryCard() {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const requestPin = usePinGuard();
  const [range, setRange] = useState<HistoryRange>('7d');
  const [severity, setSeverity] = useState<SecuritySeverity | 'all'>('all');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const query = useSecurityHistory({ range, severity });
  const { resolve } = useSecurityActions();

  const events = query.data?.events ?? [];
  const openCount = events.filter((event) => event.resolvedAt === null).length;

  const askResolve = (event: SecurityEventRecord) => {
    const note = notes[event.id]?.trim();
    requestPin({
      title: t('security.history.resolvePinTitle'),
      description: t('security.history.resolvePinDescription', {
        title: `${tCommon(`alarm.types.${securityAlarmKind(event.eventType)}`)} · ${event.deviceName}`,
      }),
      action: t('security.history.resolvePinAction'),
      onConfirm: () => {
        resolve.mutate({ id: event.id, ...(note ? { notes: note } : {}) });
        setNotes((current) => ({ ...current, [event.id]: '' }));
      },
    });
  };

  return (
    <Card data-testid="security-history-card">
      <CardHeader className="flex-wrap">
        <div>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4 text-accent" aria-hidden /> {t('security.history.title')}
          </CardTitle>
          <CardDescription className="mt-1">{t('security.history.description')}</CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={cn('size-3.5', query.isFetching && 'animate-spin')} aria-hidden />
          {t('security.history.refresh')}
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t('security.history.rangeLabel')}
            className="flex flex-wrap gap-1"
          >
            {RANGES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRange(option)}
                aria-pressed={range === option}
                className={cn(
                  'h-9 rounded-xl border px-3 text-[11px] font-semibold transition-colors',
                  range === option
                    ? 'border-accent/40 bg-accent-soft text-accent'
                    : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                )}
              >
                {t(`security.history.range.${option}`)}
              </button>
            ))}
          </div>

          <select
            value={severity}
            aria-label={t('security.history.severityLabel')}
            onChange={(event) => setSeverity(event.target.value as SecuritySeverity | 'all')}
            className="h-9 rounded-xl border border-line bg-panel-2 px-2 text-[11px] text-fg"
          >
            {SEVERITIES.map((option) => (
              <option key={option} value={option}>
                {t(`security.history.severity.${option}`)}
              </option>
            ))}
          </select>

          <span className="ml-auto text-[10px] text-fg-subtle">
            {t('security.history.count', { count: events.length, open: openCount })}
          </span>
        </div>

        {query.isError ? (
          <p role="alert" className="text-[11px] font-medium text-danger">
            {t('security.history.error', {
              message: query.error instanceof Error ? query.error.message : '',
            })}
          </p>
        ) : null}

        {query.isLoading ? (
          <p
            data-testid="security-history-loading"
            className="py-4 text-center text-[11px] text-fg-subtle"
          >
            {t('security.history.loading')}
          </p>
        ) : events.length === 0 ? (
          <p data-testid="security-history-empty" className="py-4 text-center text-[11px] text-fg-subtle">
            {t('security.history.empty')}
          </p>
        ) : (
          <ul
            data-testid="security-history-list"
            className="max-h-[26rem] divide-y divide-line/60 overflow-y-auto rounded-xl border border-line bg-bg/40 kiosk-scroll"
          >
            {events.map((event) => {
              const lifecycle = securityLifecycle(event);
              return (
                <li
                  key={event.id}
                  className="flex flex-col gap-1.5 px-3 py-2.5"
                  data-testid="security-history-row"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={SEVERITY_VARIANT[event.severity]}>
                      {t(`security.history.severity.${event.severity}`)}
                    </Badge>
                    <span className="text-xs font-medium text-fg">
                      {tCommon(`alarm.types.${securityAlarmKind(event.eventType)}`)}
                    </span>
                    <span className="text-[11px] text-fg-muted">
                      {[event.deviceName, event.roomName].filter(Boolean).join(' · ')}
                    </span>
                    <span className="tabular ml-auto text-[11px] text-fg-subtle">
                      {formatMoment(event.triggeredAt)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-fg-subtle">
                    <Badge variant={LIFECYCLE_VARIANT[lifecycle]}>
                      {t(`security.history.status.${lifecycle}`)}
                    </Badge>
                    {event.acknowledgedAt ? (
                      <span>{t('security.history.acknowledgedAt', { when: formatMoment(event.acknowledgedAt) })}</span>
                    ) : null}
                    {event.resolvedAt ? (
                      <span>{t('security.history.resolvedAt', { when: formatMoment(event.resolvedAt) })}</span>
                    ) : null}
                  </div>

                  {event.notes ? (
                    <p className="text-[10px] leading-relaxed text-fg-muted">
                      {t('security.history.note', { notes: event.notes })}
                    </p>
                  ) : null}

                  {lifecycle !== 'resolved' ? (
                    <div className="flex flex-wrap gap-2">
                      <Input
                        value={notes[event.id] ?? ''}
                        onChange={(input) =>
                          setNotes((current) => ({ ...current, [event.id]: input.target.value }))
                        }
                        aria-label={t('security.history.noteLabel', { id: event.id })}
                        placeholder={t('security.history.notePlaceholder')}
                        maxLength={500}
                        className="h-9 min-w-40 flex-1 text-xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => askResolve(event)}
                        disabled={resolve.isPending}
                      >
                        {t('security.history.resolve')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
