import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import { climateApi } from '@/lib/climateApi';
import type {
  ClimateOverrideRequest,
  ClimateRuntimeState,
  ClimateScheduleInput,
  ClimateScheduleResponse,
} from '@/types/climate';

/** Un solo profilo per dispositivo: programma + stato runtime nella stessa voce. */
export const climateQueryKey = (deviceId: string) => ['climate', deviceId] as const;

/**
 * Il programma cambia solo quando qualcuno lo modifica (o quando un override
 * scade): un minuto di `staleTime` tiene i badge aggiornati senza martellare
 * l'API su un pannello sempre acceso.
 */
const CLIMATE_STALE_TIME = 60_000;

export function useClimateSchedule(
  deviceId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ClimateScheduleResponse> {
  return useQuery({
    queryKey: climateQueryKey(deviceId),
    queryFn: () => climateApi.getSchedule(deviceId),
    staleTime: CLIMATE_STALE_TIME,
    enabled: options.enabled ?? true,
    // Solo mentre un override o una vacanza sono attivi: il badge deve sparire
    // entro un minuto dalla scadenza (il job lato server li azzera in quel
    // momento), senza interrogare l'API per il resto della giornata.
    refetchInterval: (query) =>
      query.state.data?.runtime?.override || query.state.data?.runtime?.vacation
        ? 60_000
        : false,
  });
}

type ScheduleCache = ClimateScheduleResponse | undefined;

/**
 * Salvataggio dell'intera settimana con aggiornamento ottimistico: la
 * timeline non deve "saltare" mentre la richiesta è in volo. In caso di
 * errore la cache torna esattamente allo stato precedente.
 */
export function useSaveClimateSchedules(deviceId: string) {
  const queryClient = useQueryClient();
  const queryKey = climateQueryKey(deviceId);

  return useMutation({
    mutationFn: (schedules: readonly ClimateScheduleInput[]) =>
      climateApi.saveSchedules(deviceId, schedules),
    onMutate: async (schedules) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ScheduleCache>(queryKey);

      if (previous) {
        queryClient.setQueryData<ClimateScheduleResponse>(queryKey, {
          ...previous,
          schedules: schedules.map((schedule, index) => ({
            ...schedule,
            id: `optimistic-${index}`,
          })),
        });
      }

      return { previous };
    },
    onError: (_error, _schedules, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/** Applica alla cache una funzione pura sul runtime (set/clear istantanei). */
function patchRuntime(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: ReturnType<typeof climateQueryKey>,
  patch: (runtime: ClimateRuntimeState) => ClimateRuntimeState,
): ScheduleCache {
  const previous = queryClient.getQueryData<ScheduleCache>(queryKey);
  if (previous) {
    queryClient.setQueryData<ClimateScheduleResponse>(queryKey, {
      ...previous,
      runtime: patch(previous.runtime),
    });
  }
  return previous;
}

/**
 * Override manuale: la temperatura è già stata inviata al broker dal widget
 * (`sendAction`), qui si registra solo la durata perché il job smetta di
 * riallineare il dispositivo al programma.
 */
export function useSetClimateOverride(deviceId: string) {
  const queryClient = useQueryClient();
  const queryKey = climateQueryKey(deviceId);

  return useMutation({
    mutationFn: (request: ClimateOverrideRequest) => climateApi.setOverride(deviceId, request),
    onMutate: async (request) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = patchRuntime(queryClient, queryKey, (runtime) => ({
        ...runtime,
        override: {
          targetTemp: request.targetTemp,
          preset: request.preset ?? 'comfort',
          until: request.durationMinutes
            ? Date.now() + request.durationMinutes * 60_000
            : request.until === 'permanent'
              ? null
              : (queryClient.getQueryData<ScheduleCache>(queryKey)?.nextChangeAt ?? null),
          permanent: request.until === 'permanent',
        },
      }));
      return { previous };
    },
    onError: (_error, _request, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export function useClearClimateOverride(deviceId: string) {
  const queryClient = useQueryClient();
  const queryKey = climateQueryKey(deviceId);

  return useMutation({
    mutationFn: () => climateApi.clearOverride(deviceId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
      const previous = patchRuntime(queryClient, queryKey, (runtime) => ({
        ...runtime,
        override: null,
      }));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export function useClimateVacation(deviceId: string) {
  const queryClient = useQueryClient();
  const queryKey = climateQueryKey(deviceId);

  return useMutation({
    mutationFn: (input: { active: boolean; until: string | null }) =>
      climateApi.setVacation(deviceId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}
