import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SECURITY_QUERY_KEY } from '@/hooks/useSecuritySync';
import {
  securityApi,
  type SecurityArmMode,
  type SecurityEventRecord,
  type SecurityHistoryPage,
  type SecuritySeverity,
  type ZonePatch,
} from '@/lib/securityApi';
import { useSecurityStore } from '@/store/securityStore';

/** Chiave dello storico: separata dallo snapshot live (filtri diversi). */
export const SECURITY_HISTORY_KEY = ['security', 'history'] as const;

export type HistoryRange = '24h' | '7d' | '30d' | 'all';

const RANGE_MS: Record<Exclude<HistoryRange, 'all'>, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};

/** Pagina unica: il pannello non deve scaricare anni di eventi per mostrarne 12. */
export const HISTORY_PAGE_SIZE = 100;

export interface HistoryFilters {
  range: HistoryRange;
  severity: SecuritySeverity | 'all';
}

/**
 * Storico allarmi filtrato per finestra temporale e severità.
 *
 * L'ordinamento è decrescente sul server (evento più recente in cima), quindi
 * `from` è sufficiente: `to` resta libero per includere il presente. La chiave
 * include i filtri, così cambiare intervallo non mostra per un istante i dati
 * vecchi con l'etichetta nuova.
 */
export function useSecurityHistory(filters: HistoryFilters) {
  const from =
    filters.range === 'all'
      ? null
      : new Date(Date.now() - RANGE_MS[filters.range]).toISOString();

  return useQuery<SecurityHistoryPage>({
    queryKey: [...SECURITY_HISTORY_KEY, filters.range, filters.severity],
    queryFn: ({ signal }) =>
      securityApi.history({
        limit: HISTORY_PAGE_SIZE,
        ...(from ? { from } : {}),
        ...(filters.severity === 'all' ? {} : { severity: filters.severity }),
        signal,
      }),
    staleTime: 20_000,
    retry: 2,
  });
}

/**
 * Mutazioni del sistema di allarme.
 *
 * Ogni successo invalida lo snapshot live e lo storico: l'overlay, il dimmer e
 * la pagina Impostazioni leggono tutti la stessa verità dal server, quindi non
 * esistono copie locali da tenere allineate a mano.
 */
export function useSecurityActions() {
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: SECURITY_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SECURITY_HISTORY_KEY });
  };

  const adaptSnapshot = (snapshot: Awaited<ReturnType<typeof securityApi.arm>>) => {
    // Risposta immediata anche prima del refetch: l'utente ha appena premuto
    // "Inserisci" e lo stato deve cambiare subito sotto il dito.
    useSecurityStore.getState().setSnapshot(snapshot);
    invalidate();
  };

  const arm = useMutation({
    mutationFn: (mode: SecurityArmMode) => securityApi.arm(mode),
    onSuccess: adaptSnapshot,
  });

  const disarm = useMutation({
    mutationFn: () => securityApi.disarm(),
    onSuccess: adaptSnapshot,
  });

  const resolve = useMutation({
    mutationFn: (input: { id: string; notes?: string }): Promise<SecurityEventRecord | null> =>
      securityApi.resolve(input.id, input.notes),
    onSuccess: invalidate,
  });

  const updateZone = useMutation({
    mutationFn: (input: { id: string; patch: ZonePatch }) =>
      securityApi.updateZone(input.id, input.patch),
    onSuccess: invalidate,
  });

  const assignSensorZone = useMutation({
    mutationFn: (input: { deviceId: string; zoneId: string }) =>
      securityApi.assignSensorZone(input.deviceId, input.zoneId),
    onSuccess: invalidate,
  });

  return { arm, disarm, resolve, updateZone, assignSensorZone };
}
