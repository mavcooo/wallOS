import { QueryClient } from '@tanstack/react-query';

/** Unica chiave della topologia: invalidarla ricarica stanze e device. */
export const TOPOLOGY_QUERY_KEY = ['topology'] as const;

/**
 * Parametri pensati per un pannello in LAN, sempre acceso:
 * - `staleTime` 5 minuti: la topologia cambia solo da Amministrazione, non a
 *   ogni render; il refetch manuale resta disponibile.
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
