import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import { useAuthStore } from '@/store/authStore';

/**
 * La topologia dipende dal profilo attivo (un ospite non vede tutte le stanze).
 * Con `staleTime` di 5 minuti una cache sopravvivrebbe al cambio sessione: qui
 * la si invalida quando l'utente cambia e la si elimina al logout, così il
 * prossimo login riparte sempre da una risposta autorevole del gateway.
 */
export function QuerySessionBoundary() {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (status === 'anonymous') {
      queryClient.removeQueries({ queryKey: TOPOLOGY_QUERY_KEY });
      return;
    }
    if (status === 'authenticated' && userId) {
      void queryClient.invalidateQueries({ queryKey: TOPOLOGY_QUERY_KEY });
    }
  }, [queryClient, status, userId]);

  return null;
}
