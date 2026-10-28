import { QueryClient } from '@tanstack/react-query';

/** Unica chiave della topologia: invalidarla ricarica stanze e device. */
export const TOPOLOGY_QUERY_KEY = ['topology'] as const;

/** Elenco profili: gli utenti sono server-state, non uno slice di authStore. */
export const USERS_QUERY_KEY = ['users'] as const;

/**
 * Planimetria annidata (piano → stanze → dispositivi). Chiave separata dalla
 * topologia perché la forma serve solo a canvas ed editor: ogni mutazione le
 * invalida entrambe, così la stessa stanza non può divergere fra le due viste.
 */
export const FLOORPLAN_QUERY_KEY = ['floors'] as const;

/**
 * I metadati cambiano solo da Amministrazione: 15 minuti di `staleTime`
 * evitano refetch inutili su un pannello sempre acceso. Le mutazioni admin e il
 * cambio profilo invalidano la chiave in modo esplicito.
 */
export const TOPOLOGY_STALE_TIME = 15 * 60_000;

/**
 * Parametri pensati per un pannello in LAN, sempre acceso:
 * - `staleTime` 5 minuti come default: la topologia usa un override più lungo
 *   (`TOPOLOGY_STALE_TIME`), il refetch manuale resta disponibile.
 * - `retry` 3 con backoff breve: un riavvio del gateway dura pochi secondi,
 *   un tablet che mostra subito errore reagisce peggio.
 * - niente refetch on focus: sul kiosk la finestra non perde mai il focus, ma
 *   un ritorno da standby non deve generare richieste inutili.
 * - `gcTime` 30 minuti: la cache resta per un riavvio senza rete.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        retry: 3,
        retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 5_000),
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
