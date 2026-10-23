import { Database, Loader2, Info } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { activeLocale } from '@/i18n';
import { cn } from '@/lib/utils';
import { useDatabaseHealthStore } from '@/store/databaseHealthStore';

import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';

/** "PostgreSQL 17.4 on x86_64..." → "PG 17.4" per lo spazio ridotto dell'header. */
function versionLabel(version: string | null): string | null {
  if (!version) return null;
  return version.replace(/^PostgreSQL\s+/i, 'PG ');
}

function timeLabel(checkedAt: number | null): string | null {
  return checkedAt
    ? new Date(checkedAt).toLocaleTimeString(activeLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : null;
}

/** Indicatore persistente del database nell'header: verde con la versione,
 * rosso quando il polling segnala un'interruzione, neutro al primo controllo.
 * Cliccabile → pannello diagnostico con storico e dettagli.
 */
export function DatabaseBadge() {
  // Il pannello diagnostico si apre solo dal trigger: prima era legato a
  // `!isChecking`, quindi dopo il primo poll riuscito restava aperto come modale
  // e bloccava touch/swipe sull'intera dashboard.
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const status = useDatabaseHealthStore((state) => state.status);
  const version = useDatabaseHealthStore((state) => state.version);
  const latencyMs = useDatabaseHealthStore((state) => state.latencyMs);
  const error = useDatabaseHealthStore((state) => state.error);
  const checkedAt = useDatabaseHealthStore((state) => state.checkedAt);

  const versionText = versionLabel(version);
  const label =
    status === 'up'
      ? (versionText ?? t('database.badge.ok'))
      : status === 'down'
        ? t('database.badge.offline')
        : t('database.badge.checking');

  const checked = timeLabel(checkedAt);
  const checkedText = checked ? t('database.badge.checkedAt', { time: checked }) : null;
  const title =
    status === 'up'
      ? [
          `${t('database.badge.available')}${
            versionText ? ` · ${versionText.replace(/^PG /, 'PostgreSQL ')}` : ''
          }`,
          latencyMs !== null ? `${latencyMs} ms` : null,
          checkedText,
        ]
          .filter(Boolean)
          .join(' · ')
      : status === 'down'
        ? [
            error
              ? t('database.badge.unavailableTitle', { error })
              : t('database.badge.unavailable'),
            checkedText,
            t('database.badge.retry'),
          ]
            .filter(Boolean)
            .join(' · ')
        : t('database.badge.checkingTitle');

  const aria =
    status === 'up'
      ? versionText
        ? t('database.badge.availableAria', { version: versionText })
        : t('database.badge.available')
      : status === 'down'
        ? t('database.badge.unavailable')
        : t('database.badge.checkingTitle');

  // Determina se mostrare l'indicatore di "checking" (solo al primo poll o durante il timeout)
  const isChecking = status === 'checking';

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-label={aria}
        title={title}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium',
          status === 'up' && 'border-success/30 bg-success/10 text-success',
          status === 'down' && 'border-danger/30 bg-danger/10 text-danger',
          status === 'checking' && 'border-line bg-panel-2 text-fg-subtle',
        )}
      >
        {isChecking ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <span
            className={cn(
              'size-1.5 rounded-full',
              status === 'up' ? 'bg-success' : 'bg-danger',
            )}
            aria-hidden
          />
        )}
        {isChecking ? null : <Database className="size-3" aria-hidden />}
        <span className="max-w-28 truncate">{label}</span>
      </div>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogTrigger asChild>
          <button
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium transition-colors hover:bg-panel-2"
            aria-label={t('database.trigger')}
            title={t('database.trigger')}
          >
            <Info className="size-3" aria-hidden />
          </button>
        </DialogTrigger>
        <DialogContent className="p-4 max-w-sm">
          <DialogHeader className="mb-3">
            <DialogTitle>{t('database.details.title')}</DialogTitle>
          </DialogHeader>

          <DialogDescription>
            {status === 'up'
              ? t('database.details.descriptionUp', {
                  latency:
                    latencyMs !== null
                      ? `${latencyMs} ms`
                      : t('database.details.latencyUnknown'),
                })
              : status === 'down'
                ? t('database.details.descriptionDown', {
                    error: error ? t('database.details.descriptionDownError', { error }) : '',
                  })
                : t('database.details.descriptionChecking')}
          </DialogDescription>

          {/* Tabella stato corrente */}
          <div className="space-y-2 mb-4">
            <div>
              <span className="font-medium text-fg-subtle">{t('database.details.status')}</span>
              <span className={cn(
                'px-1.5 rounded text-[10px] font-medium',
                status === 'up' && 'bg-success/20 text-success',
                status === 'down' && 'bg-danger/20 text-danger',
                status === 'checking' && 'bg-panel-2 text-fg-subtle',
              )}>
                {t(`database.details.statusValue.${status}`)}
              </span>
            </div>
            <div>
              <span className="font-medium text-fg-subtle">{t('database.details.version')}</span>
              <span className="text-sm capitalize capitalize-normal">
                {versionText ?? t('database.details.versionUnavailable')}
              </span>
            </div>
            <div>
              <span className="font-medium text-fg-subtle">
                {t('database.details.latency')}
              </span>
              <span className="text-sm">
                {latencyMs !== null ? latencyMs + ' ms' : t('database.details.latencyNotMeasured')}
              </span>
            </div>
            <div>
              <span className="font-medium text-fg-subtle">
                {t('database.details.lastCheck')}
              </span>
              <span className="text-sm">
                {checked
                  ? new Date(checkedAt ?? 0).toLocaleString(activeLocale())
                  : t('database.details.never')}
              </span>
            </div>
          </div>

          {/* Cronologia controlli (ultimi 5) */}
          {status !== 'checking' && (
            <div>
              <span className="font-medium text-fg-subtle text-xs uppercase tracking-wider mb-2">
                {t('database.details.history')}
              </span>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {/* Qui potremmo iniettare la storia, ma per ora mostriamo un placeholder */}
                <span className="text-xs text-fg-muted rounded border border-panel-2 px-1.5 py-1">
                  {t('database.details.historyLoading')}
                </span>
              </div>
            </div>
          )}

          {/* Azione */}
          <div className="mt-3 pt-t border-t pt-3">
            <DialogClose
              className="w-full justify-start py-1.5 px-2 rounded text-[10px] font-medium transition-colors hover:bg-panel-2"
              aria-label={t('database.details.closeAria')}
            >
              {t('database.details.close')}
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
