import { refreshSession } from '@/lib/authApi';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

export interface DatabaseHealth {
  status: 'up' | 'down';
  /** Versione normalizzata, es. "PostgreSQL 17.4". */
  version: string | null;
  latencyMs: number | null;
  /** Codice PostgreSQL/Node o `NETWORK`/`TIMEOUT`. */
  error: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Esito di un singolo controllo scritto in `db_health_checks`. */
export type DatabaseCheckStatus = 'healthy' | 'degraded' | 'down';

export interface DatabaseCheckRecord {
  id: string;
  status: DatabaseCheckStatus;
  latencyMs: number;
  /** ISO 8601, come serializzato da PostgreSQL (`TIMESTAMPTZ`). */
  checkedAt: string;
  errorMessage: string | null;
}

const CHECK_STATUSES: readonly DatabaseCheckStatus[] = ['healthy', 'degraded', 'down'];

function isCheckStatus(value: unknown): value is DatabaseCheckStatus {
  return typeof value === 'string' && CHECK_STATUSES.includes(value as DatabaseCheckStatus);
}

/**
 * Normalizza la risposta di `GET /api/database/history`.
 *
 * Il server è già tipizzato, ma la diagnostica è letta da un tablet: una riga
 * malformata (server più vecchio, risposta parziale) viene saltata invece di
 * rompere l'intero pannello. L'ordine del server è già decrescente e resta
 * invariato.
 */
export function parseDatabaseHistory(payload: unknown): DatabaseCheckRecord[] {
  if (!Array.isArray(payload)) return [];

  const records: DatabaseCheckRecord[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (!isCheckStatus(row.status)) continue;

    const checkedAt =
      typeof row.checkedAt === 'string'
        ? row.checkedAt
        : row.checkedAt instanceof Date
          ? row.checkedAt.toISOString()
          : null;
    if (!checkedAt || Number.isNaN(Date.parse(checkedAt))) continue;

    const rawLatency = typeof row.latencyMs === 'number' ? row.latencyMs : Number(row.latencyMs);

    records.push({
      id:
        typeof row.id === 'string' || typeof row.id === 'number'
          ? String(row.id)
          : checkedAt,
      status: row.status,
      latencyMs: Number.isFinite(rawLatency) ? Math.max(0, Math.round(rawLatency)) : 0,
      checkedAt,
      errorMessage: text(row.errorMessage),
    });
  }

  return records;
}

/**
 * Legge `/api/health` con un timeout esplicito: il browser non deve restare
 * appeso se il gateway o il database non rispondono. Non lancia mai: un errore
 * di rete diventa uno stato `down` con il codice relativo.
 */
export async function fetchDatabaseHealth(options: {
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<DatabaseHealth> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(`${API_BASE}/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const data = (await response.json().catch(() => null)) as
      | { status?: unknown; database?: { status?: unknown; version?: unknown; latencyMs?: unknown; error?: unknown } }
      | null;

    const database = data?.database;
    if (database?.status === 'up' && response.ok) {
      return {
        status: 'up',
        version: text(database.version),
        latencyMs: number(database.latencyMs),
        error: null,
      };
    }

    return {
      status: 'down',
      version: null,
      latencyMs: number(database?.latencyMs),
      error: text(database?.error) ?? `HTTP_${response.status}`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      status: 'down',
      version: null,
      latencyMs: null,
      error: aborted ? 'TIMEOUT' : 'NETWORK',
    };
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Legge lo storico dei controlli (`GET /api/database/history`) con lo stesso
 * timeout esplicito di `/api/health`: il pannello di diagnostica non deve mai
 * restare con uno spinner infinito. A differenza dell'health check questa
 * funzione lancia in caso di errore: TanStack Query conserva i dati precedenti
 * e il componente può mostrare l'ultimo storico salvato con un avviso.
 */
export async function fetchDatabaseHealthHistory(options: {
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<DatabaseCheckRecord[]> {
  const limit = options.limit ?? 50;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  const send = () =>
    fetch(`${API_BASE}/database/history?limit=${limit}`, {
      credentials: 'include',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

  try {
    let response = await send();
    if (response.status === 401 && (await refreshSession())) response = await send();

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { message?: unknown; cause?: unknown }
        | null;
      throw new Error(
        text(payload?.message) ??
          (response.status === 401
            ? 'Sessione scaduta: accedi di nuovo.'
            : `Storico DB non disponibile (${response.status})`),
      );
    }

    return parseDatabaseHistory(await response.json().catch(() => null));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Timeout nel recupero dello storico DB');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
