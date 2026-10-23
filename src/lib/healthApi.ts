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
