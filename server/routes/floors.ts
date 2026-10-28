import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { normalizeGridLayout, normalizePinPosition, type Database } from '../db.js';
import { HttpError } from '../http.js';
import { topologyEventName, type TopologyEventBus } from '../services/topologyEvents.js';
import { requireAuth, requireRole } from '../session.js';
import type { AuthConfig, DeviceRow, FloorRow, RoomRow } from '../types.js';

export interface FloorDeps {
  db: Database;
  config: AuthConfig;
  /** Pubblicazione post-commit su `wallos/system/topology_changed`. */
  events: TopologyEventBus;
}

/** Geometria della griglia: gli stessi limiti del canvas (12 colonne × 8 righe). */
const GRID_COLS = 12;
const GRID_ROWS = 8;

/** Palette semantica: il database non contiene mai valori CSS arbitrari. */
const ROOM_COLORS = ['zinc', 'amber', 'teal', 'sky', 'rose'] as const;

const slugSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9:_-]{0,63}$/,
    'L’id deve essere uno slug (minuscole, cifre, - _ :) e iniziare con lettera o cifra',
  );

const gridLayoutSchema = z
  .object({
    col: z.number().int().min(1).max(GRID_COLS),
    row: z.number().int().min(1).max(GRID_ROWS),
    colSpan: z.number().int().min(1).max(GRID_COLS),
    rowSpan: z.number().int().min(1).max(GRID_ROWS),
    color: z.enum(ROOM_COLORS),
  })
  .strict()
  .refine(
    (layout) =>
      layout.col + layout.colSpan - 1 <= GRID_COLS &&
      layout.row + layout.rowSpan - 1 <= GRID_ROWS,
    { message: 'La stanza esce dalla griglia 12×8' },
  );

const pinSchema = z
  .object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
  })
  .strict();

/** `POST /api/floors` e `PATCH /api/floors/:id`. */
const floorInputSchema = z
  .object({
    id: slugSchema.optional(),
    name: z.string().trim().min(1).max(128),
    levelOrder: z.number().int().min(-99).max(999).optional(),
    icon: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

/**
 * `PUT /api/floors/:id/layout`: stanze (geometria + eventuale cambio piano) e
 * marker dei dispositivi. `floorId` assente = resta il piano corrente,
 * `floorId: null` = la stanza esce dalla planimetria (nessun piano).
 */
const floorLayoutSchema = z
  .object({
    rooms: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            floorId: z.string().trim().min(1).max(64).nullable().optional(),
            gridLayout: gridLayoutSchema,
          })
          .strict(),
      )
      .max(200),
    devices: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            roomPinPosition: pinSchema,
          })
          .strict(),
      )
      .max(2_000),
  })
  .strict();

interface FloorPlanDeviceDto {
  id: string;
  name: string;
  kind: DeviceRow['type'];
  roomPinPosition: { x: number; y: number };
}

interface FloorPlanRoomDto {
  id: string;
  label: string;
  shortLabel: string;
  icon: string;
  floorId: string | null;
  gridLayout: RoomRow['grid_layout'];
  devices: FloorPlanDeviceDto[];
}

interface FloorPlanDto {
  id: string;
  name: string;
  levelOrder: number;
  icon: string;
  rooms: FloorPlanRoomDto[];
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parsePayload<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, 'INVALID_BODY', issue?.message ?? 'Payload non valido', {
      field: issue?.path.join('.') || 'body',
    });
  }
  return parsed.data;
}

/** Id del pannello che ha originato la mutazione (stesso contratto di topology). */
function sourceClientId(request: FastifyRequest): string | undefined {
  const value = request.headers['x-client-id'];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Annuncia il cambiamento **dopo** il commit: il client invalida `['floors']` e
 * `['topology']`, quindi la nuova planimetria appare su tutti i tablet della
 * LAN senza reload.
 */
function announce(request: FastifyRequest, deps: FloorDeps, kind: 'created' | 'updated' | 'deleted', id: string): void {
  const source = sourceClientId(request);
  deps.events.publish({
    event: topologyEventName('floor', kind),
    entity: 'floor',
    id,
    timestamp: Date.now(),
    ...(source ? { sourceClientId: source } : {}),
  });
}

async function floorOr404(db: Database, id: string): Promise<FloorRow> {
  const floor = await db.findFloorById(id);
  if (!floor) throw new HttpError(404, 'FLOOR_NOT_FOUND', 'Piano non trovato');
  return floor;
}

/** Costruisce la risposta annidata piani → stanze → dispositivi. */
function buildFloors(
  floors: readonly FloorRow[],
  rooms: readonly RoomRow[],
  devices: readonly DeviceRow[],
): FloorPlanDto[] {
  const devicesByRoom = new Map<string, FloorPlanDeviceDto[]>();
  for (const device of devices) {
    const list = devicesByRoom.get(device.room_id) ?? [];
    list.push({
      id: device.id,
      name: device.name,
      kind: device.type,
      roomPinPosition: normalizePinPosition(device.room_pin_position),
    });
    devicesByRoom.set(device.room_id, list);
  }

  const roomsByFloor = new Map<string, FloorPlanRoomDto[]>();
  for (const room of rooms) {
    if (!room.floor_id) continue;
    const list = roomsByFloor.get(room.floor_id) ?? [];
    list.push({
      id: room.id,
      label: room.name,
      shortLabel: room.short_label ?? room.name,
      icon: room.icon,
      floorId: room.floor_id,
      gridLayout: normalizeGridLayout(room.grid_layout),
      devices: devicesByRoom.get(room.id) ?? [],
    });
    roomsByFloor.set(room.floor_id, list);
  }

  return floors.map((floor) => ({
    id: floor.id,
    name: floor.name,
    levelOrder: Number(floor.level_order),
    icon: floor.icon,
    rooms: (roomsByFloor.get(floor.id) ?? []).sort(
      (a, b) =>
        a.gridLayout.row - b.gridLayout.row ||
        a.gridLayout.col - b.gridLayout.col ||
        a.label.localeCompare(b.label),
    ),
  }));
}

async function readFloorDtos(db: Database): Promise<FloorPlanDto[]> {
  const [floors, rooms, devices] = await Promise.all([
    db.listFloors(),
    db.listRooms(),
    db.listDevices(),
  ]);
  return buildFloors(floors, rooms, devices);
}

/**
 * Planimetria schematica multi-piano.
 *
 * - `GET /api/floors` — piani ordinati con stanze e dispositivi annidati, la
 *   struttura letta dal canvas e dall'editor;
 * - `POST /api/floors` — nuovo piano;
 * - `PATCH/DELETE /api/floors/:id` — rinomina, riordino, eliminazione (le
 *   stanze restano, senza piano);
 * - `PUT /api/floors/:id/layout` — salvataggio bulk di geometrie e marker in
 *   **una transazione**, seguito dalla notifica MQTT post-commit.
 *
 * Tutte le mutazioni sono riservate al ruolo `admin`: la planimetria è
 * configurazione della casa, non un comando d'uso quotidiano.
 */
export function registerFloorRoutes(app: FastifyInstance, deps: FloorDeps): void {
  const authenticated = requireAuth(deps);
  const adminOnly = requireRole(deps, ['admin']);

  app.get('/api/floors', { preHandler: authenticated }, async () => {
    return { floors: await readFloorDtos(deps.db) };
  });

  app.post('/api/floors', { preHandler: adminOnly }, async (request, reply) => {
    const input = parsePayload(floorInputSchema, request.body);
    const id = input.id ?? slugify(input.name);
    if (!slugSchema.safeParse(id).success) {
      throw new HttpError(400, 'INVALID_FLOOR_ID', 'Identificativo del piano non valido', {
        field: 'id',
      });
    }
    if (await deps.db.findFloorById(id)) {
      throw new HttpError(409, 'FLOOR_EXISTS', 'Esiste già un piano con questo id');
    }

    await deps.db.createFloor({
      id,
      name: input.name,
      level_order: input.levelOrder ?? 0,
      icon: input.icon ?? 'Layers',
    });
    announce(request, deps, 'created', id);

    const floors = await readFloorDtos(deps.db);
    const floor = floors.find((candidate) => candidate.id === id);
    return reply.code(201).send({ floor });
  });

  app.patch('/api/floors/:id', { preHandler: adminOnly }, async (request) => {
    const params = request.params as { id?: string };
    const id = params.id ?? '';
    const existing = await floorOr404(deps.db, id);
    const input = parsePayload(floorInputSchema, request.body);

    await deps.db.updateFloor(id, {
      name: input.name,
      level_order: input.levelOrder ?? Number(existing.level_order),
      icon: input.icon ?? existing.icon,
    });
    announce(request, deps, 'updated', id);

    const floors = await readFloorDtos(deps.db);
    return { floor: floors.find((candidate) => candidate.id === id) };
  });

  app.delete('/api/floors/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? '';
    await floorOr404(deps.db, id);
    await deps.db.deleteFloor(id);
    announce(request, deps, 'deleted', id);
    return reply.code(204).send();
  });

  app.put('/api/floors/:id/layout', { preHandler: adminOnly }, async (request) => {
    const params = request.params as { id?: string };
    const id = params.id ?? '';
    await floorOr404(deps.db, id);
    const input = parsePayload(floorLayoutSchema, request.body);

    // Validazione referenziale prima di aprire la transazione: un id sbagliato
    // diventa un 400 con il campo colpevole, non un errore opaco a metà commit.
    const [rooms, devices, floors] = await Promise.all([
      deps.db.listRooms(),
      deps.db.listDevices(),
      deps.db.listFloors(),
    ]);
    const roomIds = new Set(rooms.map((room) => room.id));
    const deviceIds = new Set(devices.map((device) => device.id));
    const floorIds = new Set(floors.map((floor) => floor.id));

    for (const room of input.rooms) {
      if (!roomIds.has(room.id)) {
        throw new HttpError(400, 'ROOM_NOT_FOUND', `La stanza “${room.id}” non esiste`, {
          field: 'rooms',
        });
      }
      if (room.floorId && !floorIds.has(room.floorId)) {
        throw new HttpError(400, 'FLOOR_NOT_FOUND', `Il piano “${room.floorId}” non esiste`, {
          field: 'rooms',
        });
      }
    }
    for (const device of input.devices) {
      if (!deviceIds.has(device.id)) {
        throw new HttpError(400, 'DEVICE_NOT_FOUND', `Il dispositivo “${device.id}” non esiste`, {
          field: 'devices',
        });
      }
    }

    await deps.db.updateFloorLayout(id, input.rooms, input.devices);
    announce(request, deps, 'updated', id);

    const updated = await readFloorDtos(deps.db);
    return { floor: updated.find((candidate) => candidate.id === id) };
  });
}
