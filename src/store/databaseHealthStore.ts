import { create } from 'zustand';

export type DatabaseHealthStatus = 'checking' | 'up' | 'down';

export interface DatabaseHealthSnapshot {
  status: DatabaseHealthStatus;
  /** Versione normalizzata, es. "PostgreSQL 17.4". */
  version: string | null;
  latencyMs: number | null;
  /** Codice PostgreSQL/Node o `NETWORK`/`TIMEOUT`. */
  error: string | null;
  checkedAt: number | null;
}

interface DatabaseHealthState extends DatabaseHealthSnapshot {
  setHealth(snapshot: DatabaseHealthSnapshot): void;
}

/**
 * Ultimo esito del polling su `/api/health`. Vive fuori dai componenti così
 * header e monitor condividono lo stesso dato senza due loop di fetch.
 */
export const useDatabaseHealthStore = create<DatabaseHealthState>()((set) => ({
  status: 'checking',
  version: null,
  latencyMs: null,
  error: null,
  checkedAt: null,
  setHealth(snapshot) {
    set(snapshot);
  },
}));
