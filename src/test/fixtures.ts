import { SCENARIOS } from '../../server/seed-data/scenarios';
import { initialDevices } from '../../server/seed-data/devices';
import { SEED_ROOMS } from '../../server/seed-data/rooms';

import type { RoomConfig } from '@/lib/rooms';
import type { Topology } from '@/lib/topologyApi';
import type { Device } from '@/types/device';

/**
 * I test usano lo stesso seed che il server inserisce in PostgreSQL: unica
 * fonte di verità per topic, tipi e geometria dei widget.
 */
export function deviceOf<K extends Device['kind']>(
  id: string,
  kind: K,
): Extract<Device, { kind: K }> {
  const device = initialDevices.find((item) => item.id === id);
  if (!device) throw new Error(`device "${id}" non presente nel seed del server`);
  if (device.kind !== kind) {
    throw new Error(`device "${id}" è di tipo ${device.kind}, atteso ${kind}`);
  }
  return device as Extract<Device, { kind: K }>;
}

export const SEED_ROOM_CONFIGS: RoomConfig[] = SEED_ROOMS.map((room) => ({
  id: room.id,
  label: room.name,
  shortLabel: room.shortLabel ?? room.name,
}));

/** Payload equivalente a `GET /api/topology` subito dopo il seed. */
export const SEED_TOPOLOGY: Topology = {
  rooms: SEED_ROOM_CONFIGS,
  devices: [...initialDevices],
  scenarios: [...SCENARIOS],
};
