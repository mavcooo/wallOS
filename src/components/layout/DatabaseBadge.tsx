import { Database, Loader2, Info } from 'lucide-react';

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
  return checkedAt ? new Date(checkedAt).toLocaleTimeString() : null;
}

/** Indicatore persistente del database nell'header: verde con la versione,
 * rosso quando il polling segnala un'interruzione, neutro al primo controllo.
 * Cliccabile → pannello diagnostico con storico e dettagli.
 */
export function DatabaseBadge() {
  const status = useDatabaseHealthStore((state) => state.status);
  const version = useDatabaseHealthStore((state) => state.version);
  const latencyMs = useDatabaseHealthStore((state) => state.latencyMs);
  const error = useDatabaseHealthStore((state) => state.error);
  const checkedAt = useDatabaseHealthStore((state) => state.checkedAt);

  const versionText = versionLabel(version);
  const label =
    status === 'up' ? (versionText ?? 'DB ok') : status === 'down' ? 'DB offline' : 'DB…';

  const checked = timeLabel(checkedAt);
  const title =
    status === 'up'
      ? [
          `Database disponibile${versionText ? ` · ${versionText.replace(/^PG /, 'PostgreSQL ')}` : ''}`,
          latencyMs !== null ? `${latencyMs} ms` : null,
          checked ? `ultimo controllo ${checked}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : status === 'down'
        ? [
            `Database non raggiungibile${error ? ` (${error})` : ''}`,
            checked ? `ultimo controllo ${checked}` : null,
            'nuovo tentativo automatico',
          ]
            .filter(Boolean)
            .join(' · ')
        : 'Verifica del database in corso';

  const aria =
    status === 'up'
      ? `Database disponibile${versionText ? `, ${versionText}` : ''}`
      : status === 'down'
        ? 'Database non raggiungibile'
        : 'Verifica del database in corso';

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
        onClick={() => {}}
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
      <Dialog
        open={!isChecking}
        onOpenChange={(open) => {
          if (!open) {
            useDatabaseHealthStore.setState({ status: 'checking' });
            useDatabaseHealthStore.getState().setHealth({
              status: 'checking',
              version: null,
              latencyMs: null,
              error: null,
              checkedAt: null,
            });
          }
        }}
      >
        <DialogTrigger asChild>
          <button
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium transition-colors hover:bg-panel-2"
            aria-label="Visualizza diagnostica database"
            title="Visualizza diagnostica database"
          >
            <Info className="size-3" aria-hidden />
          </button>
        </DialogTrigger>
        <DialogContent className="p-4 max-w-sm">
          <DialogHeader className="mb-3">
            <DialogTitle>Diagnostica Database</DialogTitle>
          </DialogHeader>

          <DialogDescription>
            {status === 'up'
              ? `Database raggiungibile in ${latencyMs !== null ? latencyMs + ' ms' : 'tempo sconosciuto'}.`
              : status === 'down'
                ? `Database non raggiungibile${error ? ': ' + error : ''}.`
                : 'Verifica del database in corso.'}
          </DialogDescription>

          {/* Tabella stato corrente */}
          <div className="space-y-2 mb-4">
            <div>
              <span className="font-medium text-fg-subtle">Stato:</span>
              <span className={cn(
                'px-1.5 rounded text-[10px] font-medium',
                status === 'up' && 'bg-success/20 text-success',
                status === 'down' && 'bg-danger/20 text-danger',
                status === 'checking' && 'bg-panel-2 text-fg-subtle',
              )}>
                {status}
              </span>
            </div>
            <div>
              <span className="font-medium text-fg-subtle">Versione:</span>
              <span className="text-sm capitalize capitalize-normal">
                {versionText ?? 'Non disponibile'}
              </span>
            </div>
            <div>
              <span className="font-medium text-fg-subtle">Latenza:</span>
              <span className="text-sm">
                {latencyMs !== null ? latencyMs + ' ms' : 'Non misurata'}
              </span>
            </div>
            <div>
              <span className="font-medium text-fg-subtle">Ultimo controllo:</span>
              <span className="text-sm">
                {checked ? new Date(checkedAt ?? 0).toLocaleString() : 'Mai'}
              </span>
            </div>
          </div>

          {/* Cronologia controlli (ultimi 5) */}
          {status !== 'checking' && (
            <div>
              <span className="font-medium text-fg-subtle text-xs uppercase tracking-wider mb-2">Storico ultimi 5 controlli</span>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {/* Qui potremmo iniettare la storia, ma per ora mostriamo un placeholder */}
                <span className="text-xs text-fg-muted rounded border border-panel-2 px-1.5 py-1">
                  Caricamento storico...
                </span>
              </div>
            </div>
          )}

          {/* Azione */}
          <div className="mt-3 pt-t border-t pt-3">
            <DialogClose
              className="w-full justify-start py-1.5 px-2 rounded text-[10px] font-medium transition-colors hover:bg-panel-2"
              aria-label="Chiudi pannello diagnostica"
            >
              Chiudi
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
