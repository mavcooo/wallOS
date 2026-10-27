import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import { automationsApi } from '@/lib/automationsApi';
import type {
  Automation,
  AutomationDraft,
  AutomationLogEntry,
  DeviceAutomationActivity,
} from '@/types/automations';

/** Chiave unica della lista: invalidarla invalida anche gli storici. */
export const automationsQueryKey = ['automations'] as const;

export const automationLogsQueryKey = (id: string, limit = 10) =>
  ['automations', id, 'logs', limit] as const;

export const automationActivityQueryKey = ['automations', 'activity'] as const;

/**
 * Attività del motore per device: una sola richiesta per tutto il pannello
 * (la chiave è condivisa: venti card non fanno venti chiamate). Il badge
 * risponde a "chi ha comandato questa luce?", quindi cambia raramente ma deve
 * arrivare senza ricaricare la pagina.
 */
export function useAutomationActivity(): UseQueryResult<DeviceAutomationActivity[]> {
  return useQuery({
    queryKey: automationActivityQueryKey,
    queryFn: () => automationsApi.activity().then((response) => response.activity),
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: false,
  });
}

/**
 * Lista delle regole con il badge dell'ultima esecuzione. Un pannello a parete
 * resta acceso per giorni: il refetch al minuto tiene fresco "ultimo scatto"
 * senza che nessuno debba ricaricare la pagina.
 */
export function useAutomations(): UseQueryResult<Automation[]> {
  return useQuery({
    queryKey: automationsQueryKey,
    queryFn: () => automationsApi.list().then((response) => response.automations),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Storico delle ultime esecuzioni: caricato solo quando il drawer è aperto. */
export function useAutomationLogs(
  automationId: string | null,
  limit = 10,
): UseQueryResult<AutomationLogEntry[]> {
  return useQuery({
    queryKey: automationLogsQueryKey(automationId ?? 'none', limit),
    queryFn: () =>
      automationsApi.logs(automationId ?? '', limit).then((response) => response.logs),
    enabled: automationId !== null,
    staleTime: 10_000,
  });
}

/** Applica alla cache la regola aggiornata, senza aspettare il refetch. */
function replaceInCache(queryClient: ReturnType<typeof useQueryClient>, automation: Automation) {
  queryClient.setQueryData<Automation[]>(automationsQueryKey, (previous) =>
    previous?.map((entry) => (entry.id === automation.id ? automation : entry)),
  );
}

export function useSaveAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, draft }: { id?: string; draft: AutomationDraft }) =>
      id ? automationsApi.update(id, draft) : automationsApi.create(draft),
    onSuccess: ({ automation }) => {
      replaceInCache(queryClient, automation);
      // Il motore ha ricaricato la cache: lista e storici tornano allineati.
      void queryClient.invalidateQueries({ queryKey: automationsQueryKey });
    },
  });
}

/**
 * Switch rapido con aggiornamento ottimistico: il dito deve vedere il cambio
 * di stato subito, e il valore precedente torna in caso di errore.
 */
export function useToggleAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive?: boolean }) =>
      automationsApi.toggle(id, isActive),
    onMutate: async ({ id, isActive }) => {
      await queryClient.cancelQueries({ queryKey: automationsQueryKey });
      const previous = queryClient.getQueryData<Automation[]>(automationsQueryKey);
      if (previous) {
        queryClient.setQueryData<Automation[]>(
          automationsQueryKey,
          previous.map((entry) =>
            entry.id === id ? { ...entry, isActive: isActive ?? !entry.isActive } : entry,
          ),
        );
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(automationsQueryKey, context.previous);
    },
    onSuccess: ({ automation }) => replaceInCache(queryClient, automation),
    onSettled: () => queryClient.invalidateQueries({ queryKey: automationsQueryKey }),
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => automationsApi.remove(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: automationsQueryKey }),
  });
}

/** Esecuzione di prova: restituisce l'esito per il badge "ultima esecuzione". */
export function useTestAutomation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => automationsApi.test(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: automationsQueryKey }),
  });
}
