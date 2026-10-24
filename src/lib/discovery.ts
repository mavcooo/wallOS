import { UNASSIGNED_ROOM_ID, roomIdFromLabel, type RoomConfig } from './rooms';
import type { Topology } from './topologyApi';
import type { Device } from '@/types/device';

/**
 * Entità scoperte via Home Assistant MQTT Discovery.
 *
 * Non sono topologia persistita su PostgreSQL (nessuna tabella le contiene),
 * quindi non possono vivere in `homeStore`. Restano un'estensione della
 * topologia servita da TanStack Query: la cache HTTP viene fusa con questo
 * snapshot locale e i metadati scoperti tornano al riavvio prima che il broker
 * consegni i retained.
 *
 * Lo snapshot contiene solo anagrafica (topic, adapter, stanza): lo stato
 * runtime arriva dal broker e vive in `homeStore.deviceStates`.
 */

export const DISCOVERY_CACHE_KEY = 'domus.discovery.cache';

export interface DiscoverySnapshot {
  devices: Device[];
  rooms: RoomConfig[];
}

const EMPTY_SNAPSHOT: DiscoverySnapshot = { devices: [], rooms: [] };

function isDevice(value: unknown): value is Device {
  const candidate = value as Partial<Device> | null;
  return Boolean(candidate && typeof candidate.id === 'string' && candidate.discovery);
}

function isRoom(value: unknown): value is RoomConfig {
  const candidate = value as Partial<RoomConfig> | null;
  return Boolean(candidate && typeof candidate.id === 'string' && typeof candidate.label === 'string');
}

/** Lettura difensiva: una cache corrotta non deve impedire il bootstrap. */
export function readDiscoverySnapshot(): DiscoverySnapshot {
  try {
    const raw = globalThis.localStorage?.getItem(DISCOVERY_CACHE_KEY);
    if (!raw) return EMPTY_SNAPSHOT;
    const parsed = JSON.parse(raw) as Partial<DiscoverySnapshot> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY_SNAPSHOT;
    return {
      devices: Array.isArray(parsed.devices) ? parsed.devices.filter(isDevice) : [],
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms.filter(isRoom) : [],
    };
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

function writeSnapshot(snapshot: DiscoverySnapshot): void {
  try {
    globalThis.localStorage?.setItem(DISCOVERY_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage pieno o disabilitato: la discovery resta valida per la sessione.
  }
}

export function clearDiscoverySnapshot(): void {
  try {
    globalThis.localStorage?.removeItem(DISCOVERY_CACHE_KEY);
  } catch {
    // Niente da cancellare.
  }
}

/** Stanze del server prima, poi quelle scoperte non ancora presenti. */
export function mergeRooms(
  serverRooms: readonly RoomConfig[],
  discoveredRooms: readonly RoomConfig[],
): RoomConfig[] {
  const merged = [...serverRooms];
  for (const room of discoveredRooms) {
    if (!room?.id || !room.label) continue;
    if (!merged.some((existing) => existing.id === room.id)) merged.push(room);
  }
  return merged;
}

function shortLabelOf(label: string): string {
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

function roomFor(
  rooms: readonly RoomConfig[],
  announced: Device,
): { rooms: RoomConfig[]; room: RoomConfig } {
  const area = announced.discovery?.area?.trim();
  if (!area) {
    const unassigned =
      rooms.find((room) => room.id === UNASSIGNED_ROOM_ID) ?? {
        id: UNASSIGNED_ROOM_ID,
        label: 'Non assegnati',
        shortLabel: 'Altro',
      };
    return {
      rooms: rooms.some((room) => room.id === unassigned.id) ? [...rooms] : [...rooms, unassigned],
      room: unassigned,
    };
  }

  // Stessa area già presente (anche con id diverso dal nostro slug): si riusa.
  const existing =
    rooms.find((room) => room.label.toLowerCase() === area.toLowerCase()) ??
    rooms.find((room) => room.id === roomIdFromLabel(area));
  if (existing) return { rooms: [...rooms], room: existing };

  const room: RoomConfig = {
    id: roomIdFromLabel(area),
    label: area,
    shortLabel: shortLabelOf(area),
  };
  return { rooms: [...rooms, room], room };
}

/** Fonde la topologia HTTP con le entità scoperte salvate sul dispositivo. */
export function mergeTopologyWithDiscovery(topology: Topology): Topology {
  const snapshot = readDiscoverySnapshot();
  const known = new Set(topology.devices.map((device) => device.id));
  return {
    rooms: mergeRooms(topology.rooms, snapshot.rooms),
    devices: [...topology.devices, ...snapshot.devices.filter((device) => !known.has(device.id))],
    scenarios: topology.scenarios,
  };
}

export interface DiscoveryUpsertResult {
  topology: Topology;
  device: Device;
  room: RoomConfig;
}

/**
 * Inserisce o aggiorna un'entità annunciata. Una re-annuncio (retained al
 * reconnect) aggiorna i metadati; lo stato runtime già ricevuto resta in
 * `homeStore` perché qui non viene toccato.
 */
export function withDiscoveredDevice(topology: Topology, announced: Device): DiscoveryUpsertResult {
  const { rooms, room } = roomFor(topology.rooms, announced);
  const device = { ...announced, room: room.id } as Device;
  const devices = topology.devices.some((existing) => existing.id === device.id)
    ? topology.devices.map((existing) => (existing.id === device.id ? device : existing))
    : [...topology.devices, device];
  return { topology: { ...topology, rooms, devices }, device, room };
}

export function withoutDiscoveredDevice(topology: Topology, entityId: string): Topology {
  const devices = topology.devices.filter(
    (device) => device.id !== entityId && device.discovery?.entityId !== entityId,
  );
  if (devices.length === topology.devices.length) return topology;
  return { ...topology, devices };
}

/** Persistenza dello snapshot scoperto: device e stanze create dall'area HA. */
export function rememberDiscoveredDevice(device: Device, room: RoomConfig): void {
  const snapshot = readDiscoverySnapshot();
  const devices = snapshot.devices.some((item) => item.id === device.id)
    ? snapshot.devices.map((item) => (item.id === device.id ? device : item))
    : [...snapshot.devices, device];
  const rooms = mergeRooms(snapshot.rooms, [room]);
  writeSnapshot({ devices, rooms });
}

export function forgetDiscoveredDevice(entityId: string): void {
  const snapshot = readDiscoverySnapshot();
  const devices = snapshot.devices.filter(
    (device) => device.id !== entityId && device.discovery?.entityId !== entityId,
  );
  if (devices.length === snapshot.devices.length) return;
  // La stanza resta: può ospitare altre entità o essere riusata.
  writeSnapshot({ devices, rooms: snapshot.rooms });
}
