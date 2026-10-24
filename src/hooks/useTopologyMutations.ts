import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useMqttApi } from '@/mqtt/MqttProvider';
import { adminApi, type DevicePayload, type RoomPayload } from '@/lib/adminApi';
import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';

/**
 * Mutazioni della topologia: PostgreSQL → invalidazione cache → `useMqtt`
 * riconcilia gli indici e risottoscrive/annulla i topic senza reload.
 */
function useTopologyMutation<TInput, TData>(
  mutationFn: (input: TInput) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  const { refreshSubscriptions } = useMqttApi();

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TOPOLOGY_QUERY_KEY });
      // Le sottoscrizioni sono già riallineate dall'effetto su `topicIndex`;
      // la chiamata esplicita copre anche un eventuale socket riaperto nel
      // frattempo, senza aspettare il prossimo render.
      refreshSubscriptions();
    },
  });
}

export function useCreateDevice() {
  return useTopologyMutation((payload: DevicePayload) => adminApi.createDevice(payload));
}

export function useUpdateDevice() {
  return useTopologyMutation(({ id, payload }: { id: string; payload: DevicePayload }) =>
    adminApi.updateDevice(id, payload),
  );
}

export function useDeleteDevice() {
  return useTopologyMutation((id: string) => adminApi.deleteDevice(id));
}

export function useCreateRoom() {
  return useTopologyMutation((payload: RoomPayload) => adminApi.createRoom(payload));
}

export function useUpdateRoom() {
  return useTopologyMutation(({ id, payload }: { id: string; payload: RoomPayload }) =>
    adminApi.updateRoom(id, payload),
  );
}

export function useDeleteRoom() {
  return useTopologyMutation((id: string) => adminApi.deleteRoom(id));
}
