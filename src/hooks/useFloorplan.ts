import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { fetchFloors, floorplanApi } from '@/lib/floorplanApi';
import { FLOORPLAN_QUERY_KEY, TOPOLOGY_QUERY_KEY, TOPOLOGY_STALE_TIME } from '@/lib/queryClient';
import type { Floor, FloorLayoutPayload, FloorPayload } from '@/types/floorplan';

/**
 * Planimetria come server-state.
 *
 * La chiave è separata da `['topology']` perché la risposta è annidata
 * (piano → stanze → dispositivi) e serve al canvas, non ai widget. Ogni
 * mutazione e ogni evento `topology_changed` invalida **entrambe** le chiavi:
 * le stanze vivono nelle due forme e devono restare coerenti.
 */
export function useFloorplanQuery(enabled = true): UseQueryResult<Floor[]> {
  return useQuery({
    queryKey: FLOORPLAN_QUERY_KEY,
    queryFn: fetchFloors,
    staleTime: TOPOLOGY_STALE_TIME,
    // La vista a card non ha bisogno della pianta: la richiesta parte solo
    // quando l'utente apre "Pianta" (o l'editor in Amministrazione).
    enabled,
  });
}

/** Invalidazione condivisa: piani e topologia raccontano la stessa casa. */
function useInvalidateFloorplan() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: FLOORPLAN_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: TOPOLOGY_QUERY_KEY });
  };
}

export function useCreateFloor(): UseMutationResult<Floor, Error, FloorPayload> {
  const invalidate = useInvalidateFloorplan();
  return useMutation({
    mutationFn: (payload: FloorPayload) => floorplanApi.createFloor(payload),
    onSuccess: invalidate,
  });
}

export function useUpdateFloor(): UseMutationResult<
  Floor,
  Error,
  { id: string; payload: FloorPayload }
> {
  const invalidate = useInvalidateFloorplan();
  return useMutation({
    mutationFn: ({ id, payload }) => floorplanApi.updateFloor(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteFloor(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateFloorplan();
  return useMutation({
    mutationFn: (id: string) => floorplanApi.deleteFloor(id),
    onSuccess: invalidate,
  });
}

/**
 * Salvataggio bulk del layout. Il server scrive stanze e marker in una sola
 * transazione e pubblica `floor_updated`: qui si invalida subito la cache
 * locale, gli altri pannelli ricevono l'evento MQTT.
 */
export function useSaveFloorLayout(): UseMutationResult<
  Floor,
  Error,
  { id: string; payload: FloorLayoutPayload }
> {
  const invalidate = useInvalidateFloorplan();
  return useMutation({
    mutationFn: ({ id, payload }) => floorplanApi.saveLayout(id, payload),
    onSuccess: invalidate,
  });
}
