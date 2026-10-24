import type { Database, NewDevice } from './db.js';
import { hashSecret, pinLengthOf, randomId } from './security.js';
import { initialDevices } from './seed-data/devices.js';
import { SEED_ROOMS } from './seed-data/rooms.js';
import { SCENARIOS } from './seed-data/scenarios.js';
import type { AuthConfig } from './types.js';
import type { Device } from '../src/types/device.js';

/**
 * Inserisce utenti e topologia demo se assenti. `ON CONFLICT DO NOTHING` rende
 * il seed idempotente: un riavvio non sovrascrive PIN, modifiche o preferiti.
 */
export async function seedDatabase(db: Database, config: AuthConfig): Promise<void> {
  for (const room of SEED_ROOMS) {
    await db.insertRoom({
      id: room.id,
      name: room.name,
      shortLabel: room.shortLabel,
      icon: room.icon,
      displayOrder: room.displayOrder,
    });
  }

  for (const [index, device] of initialDevices.entries()) {
    await db.insertDevice(toSeedDevice(device, index));
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
function toSeedDevice(device: Device, index: number): NewDevice {
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
  };
}
