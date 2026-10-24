import { useMemo } from 'react';

import { combineDevice } from '@/lib/deviceState';
import { roomLabel } from '@/lib/rooms';
import { useHomeStore } from '@/store/homeStore';
import type { Device, DeviceRealtimeState, RoomId } from '@/types/device';
import { useDeviceMetadata, useRooms } from './useTopologyQuery';

/**
 * Riga realtime del device. Il selettore è puntiforme: la card viene
 * ridisegnata solo quando cambia *la sua* voce della mappa, non quando arriva
 * telemetria di un altro device.
 */
export function useDeviceRealtime(deviceId: string): DeviceRealtimeState | undefined {
  return useHomeStore((state) => state.deviceStates[deviceId]);
}

/**
 * View-model completo (metadati stabili + telemetria volatile).
 * `useMemo` conserva l'identità finché nessuna delle due parti cambia, così
 * `memo` sui widget può saltare i render causati dal parent.
 */
export function useDevice(deviceId: string): Device | null {
  const metadata = useDeviceMetadata(deviceId);
  const realtime = useDeviceRealtime(deviceId);
  return useMemo(() => combineDevice(metadata, realtime), [metadata, realtime]);
}

/** Etichetta stanza dal server (le stanze non vivono più nello store). */
export function useRoomLabel(roomId: RoomId): string {
  const rooms = useRooms();
  return roomLabel(rooms, roomId);
}
