import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { securityApi, type SecuritySnapshot } from '@/lib/securityApi';
import { useAuthStore } from '@/store/authStore';
import { useSecurityStore } from '@/store/securityStore';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

/** Chiave unica: ogni mutazione di sicurezza invalida questa e basta. */
export const SECURITY_QUERY_KEY = ['security', 'state'] as const;

/**
 * Polling di sicurezza: è la rete che tiene il pannello allineato anche se lo
 * stream SSE cade (tablet in sospensione, proxy che chiude gli stream) o se
 * qualche evento non arriva. Con lo stream attivo il refetch è quasi sempre
 * immediato, ma il timer resta la garanzia.
 */
const POLL_INTERVAL_MS = 20_000;

/**
 * Sincronizzazione del sistema di allarme.
 *
 * - `useQuery` legge `GET /api/security/state` (stato + zone + eventi aperti) e
 *   scrive lo snapshot nello `securityStore`, che overlay e dimmer leggono in
 *   modo sincrono;
 * - lo stream SSE `GET /api/security/stream` invalida la query appena il worker
 *   rileva un allarme o una rotta cambia lo stato, così overlay e sirena
 *   compaiono in meno di un secondo anche su un pannello appena riacceso;
 * - al logout lo store viene svuotato: nessun allarme della sessione precedente
 *   resta visibile dopo un cambio profilo.
 *
 * Va montato dentro `<QueryClientProvider>` e `<PinProvider>`: l'overlay che
 * consuma lo store **non** viene smontato quando l'utente non è autenticato
 * (il lock screen deve poter mostrare un allarme pendente).
 */
export function useSecuritySync(): void {
  const status = useAuthStore((state) => state.status);
  const queryClient = useQueryClient();
  const setSnapshot = useSecurityStore((state) => state.setSnapshot);
  const reset = useSecurityStore((state) => state.reset);

  const query = useQuery<SecuritySnapshot>({
    queryKey: SECURITY_QUERY_KEY,
    queryFn: ({ signal }) => securityApi.state(signal),
    // Senza sessione il server risponderebbe 401: niente richieste inutili.
    enabled: status === 'authenticated',
    // Lo stato di sicurezza non è un dato "freddo": 5 s di staleTime evitano
    // una raffica di chiamate se overlay e dimmer si montano insieme.
    staleTime: 5_000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 2,
  });

  useEffect(() => {
    if (query.data) setSnapshot(query.data);
  }, [query.data, setSnapshot]);

  useEffect(() => {
    if (status !== 'authenticated') reset();
  }, [status, reset]);

  useEffect(() => {
    if (status !== 'authenticated' || typeof EventSource === 'undefined') return;

    const source = new EventSource(`${API_BASE}/security/stream`, { withCredentials: true });
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: SECURITY_QUERY_KEY });
    };

    source.addEventListener('message', invalidate);
    // Riconnessione riuscita: riallinea dopo un buco di rete senza aspettare il poll.
    source.addEventListener('open', invalidate);

    return () => {
      source.removeEventListener('message', invalidate);
      source.removeEventListener('open', invalidate);
      source.close();
    };
  }, [status, queryClient]);
}
