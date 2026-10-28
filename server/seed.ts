import type { Database, NewDevice } from './db.js';
import { hashSecret, pinLengthOf, randomId } from './security.js';
import { initialDevices } from './seed-data/devices.js';
import { SEED_FLOORS } from './seed-data/floors.js';
import { SEED_ROOMS } from './seed-data/rooms.js';
import { SCENARIOS } from './seed-data/scenarios.js';
import type { AuthConfig } from './types.js';
import type { Device } from '../src/types/device.js';

/**
 * Inserisce utenti e topologia demo se assenti. `ON CONFLICT DO NOTHING` rende
 * il seed idempotente: un riavvio non sovrascrive PIN, modifiche o preferiti.
 */
export async function seedDatabase(db: Database, config: AuthConfig): Promise<void> {
  // I piani prima delle stanze: `rooms.floor_id` punta a `floors.id`.
  for (const floor of SEED_FLOORS) {
    await db.insertFloor({
      id: floor.id,
      name: floor.name,
      level_order: floor.levelOrder,
      icon: floor.icon,
    });
  }

  for (const room of SEED_ROOMS) {
    await db.insertRoom({
      id: room.id,
      name: room.name,
      shortLabel: room.shortLabel,
      icon: room.icon,
      displayOrder: room.displayOrder,
      floorId: room.floorId,
      gridLayout: room.gridLayout,
    });
  }

  // Marker distribuiti dentro la stanza (a griglia 3 colonne): il centro
  // esatto li sovrapporrebbe tutti, rendendo la planimetria demo illeggibile.
  const pinPerRoom = new Map<string, number>();
  for (const [index, device] of initialDevices.entries()) {
    const slot = pinPerRoom.get(device.room) ?? 0;
    pinPerRoom.set(device.room, slot + 1);
    await db.insertDevice(toSeedDevice(device, index, slot));
  }

  for (const [index, scenario] of SCENARIOS.entries()) {
    await db.insertScenario({
      id: scenario.id,
      name: scenario.label,
      description: scenario.description,
      icon: scenario.icon,
      protected: scenario.protected,
      actions: scenario.steps,
      displayOrder: index,
    });
  }

  if (!(await db.findUserByUsername(config.seed.adminUsername))) {
    await db.insertUser({
      id: randomId(),
      username: config.seed.adminUsername,
      displayName: config.seed.adminDisplayName,
      passwordHash: await hashSecret(config.seed.adminPassword, config.bcryptRounds),
      role: 'admin',
      pinHash: await hashSecret(config.seed.adminPin, config.bcryptRounds),
      pinLength: pinLengthOf(config.seed.adminPin),
      isKioskDevice: false,
      kioskDeviceId: null,
      allowedRooms: null,
    });
  }

  if (!(await db.findKioskByDeviceId(config.seed.kioskDeviceId))) {
    await db.insertUser({
      id: randomId(),
      username: config.seed.kioskUsername,
      displayName: config.seed.kioskDisplayName,
      // Un device kiosk non ha password: si autentica solo con device+PIN.
      passwordHash: null,
      role: 'kiosk',
      pinHash: await hashSecret(config.seed.kioskPin, config.bcryptRounds),
      pinLength: pinLengthOf(config.seed.kioskPin),
      isKioskDevice: true,
      kioskDeviceId: config.seed.kioskDeviceId,
      allowedRooms: null,
    });
  }
}

/**
 * La tabella `devices` conserva i campi interrogabili (topic, stanza, tipo) e
 * mette stato/capability/discovery in `metadata` JSONB: l'adapter non cambia.
 */
function toSeedDevice(device: Device, index: number, slot = 0): NewDevice {
  const record = device as unknown as Record<string, unknown>;
  const metadata: Record<string, unknown> = {
    state: record.state,
    availability: record.availability,
    lastSeen: record.lastSeen,
  };
  for (const key of [
    'capabilities',
    'minTemp',
    'maxTemp',
    'tempStep',
    'sources',
    'discovery',
  ] as const) {
    if (record[key] !== undefined) metadata[key] = record[key];
  }

  return {
    id: device.id,
    roomId: device.room,
    name: device.name,
    type: device.kind,
    adapter: device.adapter,
    model: device.model ?? null,
    stateTopic: device.topics.state,
    commandTopic: device.topics.command ?? null,
    availabilityTopic: device.topics.availability ?? null,
    fieldMap: device.fieldMap ?? null,
    streamUrl: device.kind === 'camera' ? device.stream.url : null,
    snapshotUrl: device.kind === 'camera' ? (device.stream.snapshotUrl ?? null) : null,
    streamProtocol: device.kind === 'camera' ? device.stream.protocol : null,
    aspectRatio: device.kind === 'camera' ? device.stream.aspectRatio : null,
    metadata,
    favorite: device.favorite,
    protected: device.protected,
    displayOrder: index,
    roomPinPosition: {
      // Griglia 4×3 con margine: resta dentro il perimetro anche con molti
      // device nella stessa stanza.
      x: 18 + (slot % 4) * 22,
      y: 22 + (Math.floor(slot / 4) % 3) * 28,
    },
  };
}
