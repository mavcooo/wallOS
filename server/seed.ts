import { loadEnvFile } from 'node:process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { Database, type NewDevice } from './db.js';
import { bootstrapMigrations } from './migrate.js';
import { hashSecret, pinLengthOf, randomId } from './security.js';
import { initialDevices } from './seed-data/devices.js';
import { SEED_FLOORS } from './seed-data/floors.js';
import { SEED_ROOMS } from './seed-data/rooms.js';
import { SCENARIOS } from './seed-data/scenarios.js';
import type { AuthConfig } from './types.js';
import type { Device } from '../src/types/device.js';

/**
 * Tabelle scritte dal seed: la topologia demo e i suoi piani. Sono anche
 * l'unico scope di `--force`, che le azzera in un solo `TRUNCATE`.
 */
export const SEED_TABLES = ['floors', 'rooms', 'devices', 'scenarios'] as const;

/** Righe già presenti, per tabella, prima di qualunque scrittura. */
export interface SeedCounts {
  floors: number;
  rooms: number;
  devices: number;
  scenarios: number;
}

export interface SeedOptions {
  /**
   * Azzera {@link SEED_TABLES} (`TRUNCATE … CASCADE`) prima di inserire i dati
   * demo. Distruttivo: raggiungibile solo dalla CLI con `--force`, mai dal
   * bootstrap del server.
   */
  force?: boolean;
  /** Destinazione dei log (default `console.log`). */
  log?: (message: string) => void;
}

export type SeedOutcome = 'seeded' | 'skipped' | 'forced';

export interface SeedResult {
  /** `true` solo se in questa esecuzione sono state scritte le righe demo. */
  seeded: boolean;
  outcome: SeedOutcome;
  /** Fotografia del database **prima** del controllo di idempotenza. */
  before: SeedCounts;
}

function describeCounts(counts: SeedCounts): string {
  return SEED_TABLES.map((table) => `${counts[table]} ${table}`).join(', ');
}

/**
 * Conteggio delle tabelle del seed in una sola query. Serve come guardia di
 * idempotenza: se una sola di queste tabelle ha righe, il database è già stato
 * popolato (o modificato dall'utente) e il seed non deve toccarlo.
 */
export async function countSeedRows(db: Database): Promise<SeedCounts> {
  const { rows } = await db.client.query<Record<string, string | number>>(
    `SELECT
       (SELECT COUNT(*)::int FROM floors) AS floors,
       (SELECT COUNT(*)::int FROM rooms) AS rooms,
       (SELECT COUNT(*)::int FROM devices) AS devices,
       (SELECT COUNT(*)::int FROM scenarios) AS scenarios`,
  );
  const row = rows[0];
  return {
    floors: Number(row?.floors ?? 0),
    rooms: Number(row?.rooms ?? 0),
    devices: Number(row?.devices ?? 0),
    scenarios: Number(row?.scenarios ?? 0),
  };
}

/**
 * Inserisce utenti e topologia demo **solo se il database è vuoto**.
 *
 * Il seed non è più una tappa incondizionata del bootstrap: con un database
 * già popolato la funzione non esegue nessuna scrittura e ritorna `skipped`.
 * Senza questa guardia un riavvio (watchdog, deploy, crash) reinseriva i dati
 * mock, facendo ricomparire stanze e dispositivi eliminati dall'utente. Le
 * INSERT restano comunque `ON CONFLICT DO NOTHING`, quindi un seed interrotto a
 * metà non genera errori al tentativo successivo.
 *
 * `--force` è l'unica via per riportare il database allo stato demo: azzera le
 * tabelle del seed e le ricrea. Gli account (admin, kiosk, famiglia) non
 * vengono mai cancellati: quelli mancanti vengono creati, quelli esistenti
 * restano intatti.
 */
export async function seedDatabase(
  db: Database,
  config: AuthConfig,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const force = options.force === true;
  const before = await countSeedRows(db);
  const populated = Object.values(before).some((count) => count > 0);

  if (force) {
    log(
      `[Seed] --force: azzero ${SEED_TABLES.join(', ')} (TRUNCATE … CASCADE) e reinserisco i dati demo`,
    );
    await db.client.query(`TRUNCATE TABLE ${SEED_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } else if (populated) {
    log(`[Seed] Database già popolato (${describeCounts(before)}): salto il seeding dei dati mock.`);
    return { seeded: false, outcome: 'skipped', before };
  }

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

  log(
    `[Seed] Dati demo inseriti: ${SEED_FLOORS.length} piani, ${SEED_ROOMS.length} stanze, ` +
      `${initialDevices.length} dispositivi, ${SCENARIOS.length} scenari`,
  );

  return { seeded: true, outcome: force ? 'forced' : 'seeded', before };
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

const USAGE = `Uso: tsx server/seed.ts [--force]

  (nessun flag)  inserisce i dati demo solo se il database è vuoto
  --force        azzera ${SEED_TABLES.join(', ')} (TRUNCATE … CASCADE) e li reinserisce
`;

/**
 * CLI `npm run db:seed`: applica le migrazioni pendenti, lo schema completo e
 * poi il seed. È l'unico modo per popolare un database con dati a scopo di
 * test o sviluppo locale: il bootstrap del server, con `AUTO_SEED=false`
 * (default), non scrive nulla.
 */
async function runCli(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--force');
  if (unknown.length > 0) {
    console.error(`[Seed] Argomento non riconosciuto: ${unknown.join(' ')}\n${USAGE}`);
    process.exit(1);
  }
  const force = argv.includes('--force');

  const config = loadConfig();
  const db = new Database({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    ssl: config.dbSsl,
    connectionTimeoutMillis: config.dbConnectTimeoutMs,
    idleTimeoutMillis: config.dbIdleTimeoutMs,
  });

  try {
    const migrations = await bootstrapMigrations();
    if (!migrations.success) {
      throw new Error(migrations.error ?? 'migrazioni non applicate');
    }
    // `schema.sql` è idempotente ed è ciò che `buildApp()` esegue a ogni avvio:
    // così la CLI funziona anche su un database appena creato.
    await db.init();

    const result = await seedDatabase(db, config, { force });
    if (!result.seeded) {
      console.log('[Seed] Nessuna riga scritta. Usa --force per ripristinare i dati demo.');
    }
  } finally {
    await db.close();
  }
}

// Stesso confronto di percorso del runner delle migrazioni (`file://` costruito
// a mano non regge su Windows): la CLI parte solo se il file è invocato
// direttamente, non quando `app.ts` lo importa.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = invokedPath !== '' && fileURLToPath(import.meta.url) === invokedPath;

if (isDirectRun) {
  try {
    // Stesso `.env` del servizio: `npm run db:seed` deve vedere le credenziali
    // di ADMIN_/KIOSK_ usate da `npm run dev:auth`.
    loadEnvFile();
  } catch {
    // Nessun `.env` locale: valgono le variabili già presenti nell'ambiente.
  }

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  void runCli(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(`[Seed] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
