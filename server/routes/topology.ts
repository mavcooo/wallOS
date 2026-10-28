import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  UNASSIGNED_ROOM_ID,
  normalizeGridLayout,
  normalizePinPosition,
  type Database,
  type DeviceFields,
  type DeviceUpdate,
  type RoomOrphanStrategy,
  type RoomUpdate,
} from '../db.js';
import { HttpError, asRecord, readString } from '../http.js';
import {
  topologyEventName,
  type TopologyChangeKind,
  type TopologyEntity,
  type TopologyEventBus,
} from '../services/topologyEvents.js';
import type { AuthConfig, DeviceRow, RoomRow, ScenarioRow } from '../types.js';
import { requireAuth, requireRole } from '../session.js';
import type {
  AdapterId,
  CameraAspectRatio,
  CameraProtocol,
  CameraState,
  ClimateState,
  Device,
  DeviceAvailability,
  DiscoveryStateChannel,
  LightState,
  MediaState,
  PowerState,
  Scenario,
  ScenarioStep,
  SensorState,
} from '../../src/types/device.js';

export interface TopologyDeps {
  db: Database;
  config: AuthConfig;
  /** Pubblicazione post-commit su `wallos/system/topology_changed`. */
  events: TopologyEventBus;
}

/**
 * Id del pannello che ha inviato la richiesta: il client lo manda in
 * `X-Client-Id`, il server lo riecheggia nel payload così quell'unico client
 * (che ha già invalidato la cache in locale) non fa un secondo refetch.
 */
function sourceClientId(request: FastifyRequest): string | undefined {
  const value = request.headers['x-client-id'];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Annuncia la mutazione **dopo** che la scrittura su PostgreSQL è stata
 * confermata: un evento non può mai precedere il dato che descrive.
 */
function announce(
  request: FastifyRequest,
  deps: TopologyDeps,
  entity: TopologyEntity,
  kind: TopologyChangeKind,
  id: string,
): void {
  const sourceClientIdValue = sourceClientId(request);
  deps.events.publish({
    event: topologyEventName(entity, kind),
    entity,
    id,
    timestamp: Date.now(),
    ...(sourceClientIdValue ? { sourceClientId: sourceClientIdValue } : {}),
  });
}

interface RoomDto {
  id: string;
  label: string;
  shortLabel: string;
  icon: string;
  displayOrder: number;
  /** Piano della planimetria; `null` = stanza non ancora assegnata. */
  floorId: string | null;
  /** Rettangolo sulla griglia 12×8 della pianta schematica. */
  gridLayout: ReturnType<typeof normalizeGridLayout>;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toRoom(row: RoomRow): RoomDto {
  return {
    id: row.id,
    label: row.name,
    shortLabel: row.short_label ?? row.name,
    icon: row.icon,
    displayOrder: row.display_order,
    floorId: row.floor_id ?? null,
    gridLayout: normalizeGridLayout(row.grid_layout),
  };
}

// ── Validazione input admin ────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const DEVICE_TYPES = ['light', 'climate', 'power', 'media', 'sensor', 'camera'] as const;
const CAMERA_PROTOCOLS = ['webrtc', 'hls', 'mjpeg', 'auto'] as const;
const ASPECT_RATIOS = ['16:9', '4:3'] as const;
const ADAPTERS = ['zigbee2mqtt', 'shelly', 'tasmota', 'custom-json', 'ha-discovery'] as const;
const CLIMATE_MODES = ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry'] as const;
const FAN_SPEEDS = ['auto', 'low', 'medium', 'high'] as const;

// ── Schemi PATCH (validazione rigorosa del payload) ────────────────────────
//
// I PATCH sono parziali: ogni campo è opzionale e quelli assenti restano
// invariati. `.strict()` è la difesa contro l'over-posting: una chiave non
// dichiarata (`role`, `malicious`, …) fa fallire il parse con 400 invece di
// essere ignorata o, peggio, di raggiungere il database.

const fieldMapSchema = z
  .record(z.string(), z.string().trim().min(1).max(256))
  .refine((map) => Object.keys(map).length <= 64, {
    message: 'fieldMap ha troppi campi (massimo 64)',
  });

const metadataSchema = z.record(z.string(), z.unknown()).refine(
  (value) => JSON.stringify(value).length <= 8_192,
  { message: 'metadata supera gli 8 kB' },
);

const pinSchema = z
  .object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
  })
  .strict();

const streamUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^(https?|webrtc):\/\/[^\s]+$/i, 'Usa un URL http(s) o webrtc://');

const snapshotUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^https?:\/\/[^\s]+$/i, 'Usa un URL http(s)');

/** `PATCH /api/devices/:id`: stessi campi del form admin, tutti opzionali. */
export const UpdateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    roomId: z.string().trim().min(1).max(64).optional(),
    type: z.enum(DEVICE_TYPES).optional(),
    adapter: z.enum(ADAPTERS).optional(),
    model: z.string().trim().min(1).max(80).nullable().optional(),
    stateTopic: z.string().trim().min(1).max(512).optional(),
    commandTopic: z.string().trim().min(1).max(512).nullable().optional(),
    availabilityTopic: z.string().trim().min(1).max(512).nullable().optional(),
    favorite: z.boolean().optional(),
    protected: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(9_999).optional(),
    fieldMap: fieldMapSchema.nullable().optional(),
    metadata: metadataSchema.optional(),
    roomPinPosition: pinSchema.optional(),
    streamUrl: streamUrlSchema.nullable().optional(),
    snapshotUrl: snapshotUrlSchema.nullable().optional(),
    streamProtocol: z.enum(CAMERA_PROTOCOLS).nullable().optional(),
    aspectRatio: z.enum(ASPECT_RATIOS).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Una telecamera senza endpoint non è configurabile: il campo resta
    // obbligatorio quando il tipo viene dichiarato nel payload.
    if (value.type === 'camera' && value.streamUrl === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['streamUrl'],
        message: 'L’URL del flusso non può essere nullo per una telecamera',
      });
    }
  });

/** `PATCH /api/rooms/:id`: i campi che il form stanza può davvero scrivere. */
export const UpdateRoomSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    shortLabel: z.string().trim().min(1).max(24).nullable().optional(),
    icon: z.string().trim().min(1).max(40).optional(),
    displayOrder: z.number().int().min(0).max(9_999).optional(),
  })
  .strict();

// ── Schemi POST (creazione) ────────────────────────────────────────────────
//
// Stessa regola dei PATCH: l'insieme delle chiavi accettate è chiuso. Le
// regole incrociate (telecamera con flusso, topic di stato obbligatorio) sono
// espresse nello schema, così un payload invalido non arriva ai builder.

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    SLUG_RE,
    'L’id deve essere uno slug (minuscole, cifre, - _ :) e iniziare con lettera o cifra',
  );

/** `null` accettato come “non specificato”, come faceva il vecchio `integerField`. */
const displayOrderSchema = z.number().int().min(0).max(9_999).nullable().optional();

/** `POST /api/rooms`. */
export const CreateRoomSchema = z
  .object({
    id: slugSchema.optional(),
    name: z.string().trim().min(1).max(80),
    shortLabel: z.string().trim().max(24).nullable().optional(),
    icon: z.string().trim().max(40).optional(),
    displayOrder: displayOrderSchema,
  })
  .strict();

/** `POST /api/devices`: telecamera e topic obbligatori sono regole incrociate. */
export const CreateDeviceSchema = z
  .object({
    id: slugSchema.optional(),
    roomId: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    type: z.enum(DEVICE_TYPES).optional(),
    adapter: z.enum(ADAPTERS).optional(),
    model: z.string().trim().max(80).nullable().optional(),
    stateTopic: z.string().trim().max(512).optional(),
    commandTopic: z.string().trim().max(512).nullable().optional(),
    availabilityTopic: z.string().trim().max(512).nullable().optional(),
    favorite: z.boolean().optional(),
    protected: z.boolean().optional(),
    displayOrder: displayOrderSchema,
    fieldMap: fieldMapSchema.nullable().optional(),
    metadata: metadataSchema.nullable().optional(),
    streamUrl: streamUrlSchema.optional(),
    snapshotUrl: snapshotUrlSchema.nullable().optional(),
    streamProtocol: z.enum(CAMERA_PROTOCOLS).nullable().optional(),
    aspectRatio: z.enum(ASPECT_RATIOS).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isCamera = value.type === 'camera';
    if (isCamera && !value.streamUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['streamUrl'],
        message: 'L’URL del flusso è obbligatorio per una telecamera',
      });
    }
    if (!isCamera && !value.stateTopic) {
      ctx.addIssue({
        code: 'custom',
        path: ['stateTopic'],
        message: 'Il topic di stato è obbligatorio',
      });
    }
  });

/** `POST /api/scenarios`: gli id dei passi sono validati da `scenarioSteps`. */
export const CreateScenarioSchema = z
  .object({
    id: slugSchema.optional(),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(240).optional(),
    icon: z.string().trim().max(40).optional(),
    protected: z.boolean().optional(),
    actions: z.array(z.unknown()).max(50),
    displayOrder: displayOrderSchema,
  })
  .strict();

type CreateRoomInput = z.infer<typeof CreateRoomSchema>;
type CreateDeviceInput = z.infer<typeof CreateDeviceSchema>;
type CreateScenarioInput = z.infer<typeof CreateScenarioSchema>;

/** Strategie ammesse per `DELETE /api/rooms/:id?orphanStrategy=…`. */
const ORPHAN_STRATEGIES = ['restrict', 'unassign', 'cascade'] as const;
const orphanStrategySchema = z.enum(ORPHAN_STRATEGIES);

/**
 * Valida il body con lo schema dato e lo traduce in `HttpError` 400 con
 * l'elenco completo delle issue di Zod (mai un messaggio generico).
 */
function parseSchema<T>(schema: z.ZodType<T>, body: unknown, label: string): T {
  const parsed = schema.safeParse(asRecord(body));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'body',
      code: issue.code,
      message: issue.message,
    }));
    const first = issues[0];
    throw new HttpError(
      400,
      'INVALID_BODY',
      `${label}: ${first?.message ?? 'payload non valido'}`,
      { field: first?.path ?? 'body', issues },
    );
  }
  return parsed.data;
}

/** Come `parseSchema`, ma un PATCH senza campi è un errore, non un no-op. */
function parsePatch<T>(schema: z.ZodType<T>, body: unknown, label: string): T {
  const data = parseSchema(schema, body, label);
  if (Object.keys(data as object).length === 0) {
    throw new HttpError(400, 'INVALID_BODY', `${label}: nessun campo da aggiornare`, {
      field: 'body',
    });
  }
  return data;
}

/** `?orphanStrategy=` assente = `restrict` (409 se restano dispositivi). */
function readOrphanStrategy(query: unknown): RoomOrphanStrategy {
  const raw = asRecord(query).orphanStrategy;
  if (raw === undefined) return 'restrict';
  const parsed = orphanStrategySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'INVALID_ORPHAN_STRATEGY',
      `orphanStrategy deve essere uno di: ${ORPHAN_STRATEGIES.join(', ')}`,
      { field: 'orphanStrategy' },
    );
  }
  return parsed.data;
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

function invalid(message: string, field?: string): HttpError {
  return new HttpError(400, 'INVALID_BODY', message, field ? { field } : undefined);
}

/** Id esplicito (slug) oppure derivato dall'etichetta per le nuove entità. */
function resolveId(explicit: string | undefined, label: string): string {
  const id = explicit ?? slugify(label);
  if (!SLUG_RE.test(id)) {
    throw invalid(
      'L’id deve essere uno slug (minuscole, cifre, - _ :) e iniziare con lettera o cifra',
      'id',
    );
  }
  return id;
}

function enumField<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalid(`${key} deve essere uno di: ${allowed.join(', ')}`, key);
  }
  return value as T;
}

function roomInput(input: CreateRoomInput): {
  id: string;
  name: string;
  shortLabel: string | null;
  icon: string;
  displayOrder: number;
} {
  return {
    id: resolveId(input.id, input.name),
    name: input.name,
    // Etichetta e icona vuote valgono “non specificata”, come prima di Zod.
    shortLabel: input.shortLabel?.length ? input.shortLabel : null,
    icon: input.icon?.length ? input.icon : 'home',
    displayOrder: input.displayOrder ?? 0,
  };
}

/**
 * Traduce il payload validato nei campi relazionali.
 * `id` arriva dal chiamante: serve anche come topic di stato di default della
 * telecamera (`camera/<id>`), esattamente come prima.
 */
function deviceInput(input: CreateDeviceInput, id: string): DeviceFields {
  const type = input.type ?? 'light';
  const isCamera = type === 'camera';

  return {
    roomId: input.roomId,
    name: input.name,
    type,
    adapter: input.adapter ?? (isCamera ? 'custom-json' : 'zigbee2mqtt'),
    model: input.model?.length ? input.model : null,
    stateTopic: isCamera
      ? (input.stateTopic?.length ? input.stateTopic : `camera/${id}`)
      : // Lo schema impone il topic per i device non-camera.
        (input.stateTopic as string),
    commandTopic: isCamera ? null : (input.commandTopic?.length ? input.commandTopic : null),
    availabilityTopic: isCamera
      ? null
      : input.availabilityTopic?.length
        ? input.availabilityTopic
        : null,
    streamUrl: isCamera ? (input.streamUrl ?? null) : null,
    snapshotUrl: isCamera ? (input.snapshotUrl ?? null) : null,
    streamProtocol: isCamera ? (input.streamProtocol ?? 'auto') : null,
    aspectRatio: isCamera ? (input.aspectRatio ?? '16:9') : null,
    favorite: input.favorite ?? false,
    protected: input.protected ?? false,
    displayOrder: input.displayOrder ?? 0,
    ...(input.fieldMap !== undefined ? { fieldMap: input.fieldMap } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata ?? {} } : {}),
  };
}

function scenarioInput(input: CreateScenarioInput): {
  id: string;
  name: string;
  description: string;
  icon: string;
  protected: boolean;
  actions: unknown;
  displayOrder: number;
} {
  return {
    id: resolveId(input.id, input.label),
    name: input.label,
    description: input.description ?? '',
    icon: input.icon?.length ? input.icon : 'sparkles',
    protected: input.protected ?? false,
    actions: scenarioSteps(input.actions),
    displayOrder: input.displayOrder ?? 0,
  };
}

/** Valida e normalizza i passi: un JSON arbitrario non entra nel DB. */
function scenarioSteps(raw: readonly unknown[]): unknown[] {
  return raw.map((item, index) => {
    const step = asRecord(item);
    const deviceId = readString(step, 'deviceId', 64);
    if (!deviceId) throw invalid(`Passo ${index + 1}: deviceId mancante`, 'actions');
    const action = validateAction(asRecord(step.action), index);
    const delayMs = step.delayMs;
    if (
      delayMs !== undefined &&
      (!Number.isInteger(delayMs) || (delayMs as number) < 0 || (delayMs as number) > 600_000)
    ) {
      throw invalid(`Passo ${index + 1}: delayMs tra 0 e 600000`, 'actions');
    }
    return {
      deviceId,
      action,
      ...(delayMs !== undefined ? { delayMs } : {}),
    };
  });
}

function validateAction(action: Record<string, unknown>, index: number): Record<string, unknown> {
  const prefix = `Passo ${index + 1}`;
  switch (action.type) {
    case 'power': {
      if (typeof action.on !== 'boolean') throw invalid(`${prefix}: on deve essere booleano`, 'actions');
      return { type: 'power', on: action.on };
    }
    case 'brightness': {
      const brightness = action.brightness;
      if (typeof brightness !== 'number' || brightness < 0 || brightness > 100) {
        throw invalid(`${prefix}: brightness tra 0 e 100`, 'actions');
      }
      return { type: 'brightness', brightness };
    }
    case 'colorTemp': {
      const kelvin = action.kelvin;
      if (typeof kelvin !== 'number' || kelvin < 1_000 || kelvin > 10_000) {
        throw invalid(`${prefix}: kelvin tra 1000 e 10000`, 'actions');
      }
      return { type: 'colorTemp', kelvin };
    }
    case 'targetTemp': {
      const targetTemp = action.targetTemp;
      if (typeof targetTemp !== 'number' || targetTemp < 5 || targetTemp > 35) {
        throw invalid(`${prefix}: targetTemp tra 5 e 35`, 'actions');
      }
      return { type: 'targetTemp', targetTemp };
    }
    case 'climateMode': {
      const mode = enumField(action, 'mode', CLIMATE_MODES, 'off');
      return { type: 'climateMode', mode };
    }
    case 'fanSpeed': {
      const fanSpeed = enumField(action, 'fanSpeed', FAN_SPEEDS, 'auto');
      return { type: 'fanSpeed', fanSpeed };
    }
    case 'swing': {
      if (typeof action.swing !== 'boolean') throw invalid(`${prefix}: swing booleano`, 'actions');
      return { type: 'swing', swing: action.swing };
    }
    case 'volume': {
      const volume = action.volume;
      if (typeof volume !== 'number' || volume < 0 || volume > 100) {
        throw invalid(`${prefix}: volume tra 0 e 100`, 'actions');
      }
      return { type: 'volume', volume };
    }
    case 'source': {
      const source = readString(action, 'source', 80);
      if (!source) throw invalid(`${prefix}: source mancante`, 'actions');
      return { type: 'source', source };
    }
    default:
      throw invalid(`${prefix}: tipo azione non supportato`, 'actions');
  }
}

async function roomOr404(db: Database, id: string): Promise<RoomRow> {
  const room = await db.findRoomById(id);
  if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Stanza non trovata');
  return room;
}

async function deviceOr404(db: Database, id: string): Promise<DeviceRow> {
  const device = await db.findDeviceById(id);
  if (!device) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Dispositivo non trovato');
  return device;
}

async function scenarioOr404(db: Database, id: string): Promise<ScenarioRow> {
  const scenario = await db.findScenarioById(id);
  if (!scenario) throw new HttpError(404, 'SCENARIO_NOT_FOUND', 'Scenario non trovato');
  return scenario;
}

function asAvailability(value: unknown): DeviceAvailability {
  return value === 'online' || value === 'offline' || value === 'unknown'
    ? value
    : 'unknown';
}

/**
 * Ricostruisce il modello `Device` dai campi relazionali + `metadata` JSONB.
 * Lo stato runtime (on/off, temperatura) è il default del seed: la telemetria
 * MQTT lo sovrascrive subito dopo il connect.
 */
function toDevice(row: DeviceRow): Device {
  const meta = parseJson<Record<string, unknown>>(row.metadata, {});
  const base = {
    id: row.id,
    name: row.name,
    room: row.room_id,
    adapter: row.adapter as AdapterId,
    ...(row.model ? { model: row.model } : {}),
    topics: {
      state: row.state_topic,
      ...(row.command_topic ? { command: row.command_topic } : {}),
      ...(row.availability_topic ? { availability: row.availability_topic } : {}),
    },
    ...(row.field_map ? { fieldMap: row.field_map } : {}),
    // Payload LWT non standard e timeout del watchdog: configurazione opzionale
    // in `metadata`, così un Tasmota con `Online` o un sensore a batteria
    // lento non richiedono una migrazione dello schema.
    ...(typeof meta.availabilityPayloadOnline === 'string'
      ? { availabilityPayloadOnline: meta.availabilityPayloadOnline }
      : {}),
    ...(typeof meta.availabilityPayloadOffline === 'string'
      ? { availabilityPayloadOffline: meta.availabilityPayloadOffline }
      : {}),
    ...(typeof meta.staleTimeoutMs === 'number' && meta.staleTimeoutMs > 0
      ? { staleTimeoutMs: meta.staleTimeoutMs }
      : {}),
    availability: asAvailability(meta.availability),
    lastSeen: typeof meta.lastSeen === 'number' ? meta.lastSeen : null,
    favorite: row.favorite,
    protected: row.protected,
    displayOrder: row.display_order,
    roomPinPosition: normalizePinPosition(row.room_pin_position),
    ...(meta.discovery
      ? {
          discovery: {
            ...(meta.discovery as Record<string, unknown>),
            state: (meta.discovery as { state?: DiscoveryStateChannel[] }).state ?? [],
          } as Device['discovery'],
        }
      : {}),
  };

  switch (row.type) {
    case 'light':
      return {
        ...base,
        kind: 'light',
        state: (meta.state as LightState) ?? { on: false, brightness: 0 },
        capabilities: (meta.capabilities as { dimmable: boolean }) ?? { dimmable: false },
      };
    case 'climate':
      return {
        ...base,
        kind: 'climate',
        state:
          (meta.state as ClimateState) ?? {
            mode: 'off',
            targetTemp: 20,
            currentTemp: 20,
            fanSpeed: 'auto',
            swing: false,
            action: 'idle',
          },
        minTemp: typeof meta.minTemp === 'number' ? meta.minTemp : 5,
        maxTemp: typeof meta.maxTemp === 'number' ? meta.maxTemp : 30,
        tempStep: typeof meta.tempStep === 'number' ? meta.tempStep : 0.5,
      };
    case 'power':
      return {
        ...base,
        kind: 'power',
        state:
          (meta.state as PowerState) ?? {
            on: false,
            watts: 0,
            voltage: 230,
            current: 0,
            energyTodayKwh: 0,
            energyTotalKwh: 0,
            maxWatts: 2_000,
          },
      };
    case 'media':
      return {
        ...base,
        kind: 'media',
        state:
          (meta.state as MediaState) ?? {
            power: false,
            volume: 0,
            muted: false,
            source: '',
            nowPlaying: null,
          },
        sources: Array.isArray(meta.sources) ? (meta.sources as string[]) : [],
      };
    case 'sensor':
      return {
        ...base,
        kind: 'sensor',
        state: (meta.state as SensorState) ?? { value: 0, unit: '', type: 'temperature' },
      };
    case 'camera':
      return {
        ...base,
        kind: 'camera',
        state: (meta.state as CameraState) ?? { live: true },
        stream: {
          url: row.stream_url ?? '',
          ...(row.snapshot_url ? { snapshotUrl: row.snapshot_url } : {}),
          protocol: (row.stream_protocol as CameraProtocol | null) ?? 'auto',
          aspectRatio: (row.aspect_ratio as CameraAspectRatio | null) ?? '16:9',
        },
      };
  }
}

function toScenario(row: ScenarioRow): Scenario {
  const steps = parseJson<ScenarioStep[]>(row.actions, []);
  return {
    id: row.id,
    label: row.name,
    description: row.description,
    icon: row.icon,
    protected: row.protected,
    steps: Array.isArray(steps) ? steps : [],
    displayOrder: row.display_order,
  };
}

export function registerTopologyRoutes(app: FastifyInstance, deps: TopologyDeps): void {
  const preHandler = requireAuth(deps);

  app.get('/api/topology', { preHandler }, async () => {
    const [roomRows, deviceRows, scenarioRows] = await Promise.all([
      deps.db.listRooms(),
      deps.db.listDevices(),
      deps.db.listScenarios(),
    ]);

    return {
      rooms: roomRows.map(toRoom),
      devices: deviceRows.map(toDevice),
      scenarios: scenarioRows.map(toScenario),
    };
  });

  app.get('/api/rooms', { preHandler }, async () => {
    const rows = await deps.db.listRooms();
    return { rooms: rows.map(toRoom) };
  });

  app.get('/api/devices', { preHandler }, async () => {
    const rows = await deps.db.listDevices();
    return { devices: rows.map(toDevice) };
  });

  app.get('/api/scenarios', { preHandler }, async () => {
    const rows = await deps.db.listScenarios();
    return { scenarios: rows.map(toScenario) };
  });

  // ── Mutazioni (solo amministratore) ──────────────────────────────────────

  const adminOnly = requireRole(deps, ['admin']);

  app.post('/api/rooms', { preHandler: adminOnly }, async (request, reply) => {
    const input = roomInput(parseSchema(CreateRoomSchema, request.body, 'Stanza non valida'));
    if (await deps.db.findRoomById(input.id)) {
      throw new HttpError(409, 'ROOM_EXISTS', 'Esiste già una stanza con questo id');
    }
    await deps.db.createRoom(input);
    announce(request, deps, 'room', 'created', input.id);
    return reply.code(201).send({ room: toRoom(await roomOr404(deps.db, input.id)) });
  });

  app.patch('/api/rooms/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = asRecord(request.params);
    const id = typeof params.id === 'string' ? params.id : '';
    // 404 prima della validazione: un id inesistente resta "non trovato"
    // anche con un body vuoto o malformato.
    const existing = await roomOr404(deps.db, id);
    const patch: RoomUpdate = parsePatch(UpdateRoomSchema, request.body, 'Stanza non valida');

    await deps.db.updateRoom(id, patch);
    // Solo un ordine diverso è un riordino; il resto è un aggiornamento.
    const reordered =
      patch.displayOrder !== undefined && patch.displayOrder !== existing.display_order;
    announce(request, deps, 'room', reordered ? 'reordered' : 'updated', id);
    return reply.send({ room: toRoom(await roomOr404(deps.db, id)) });
  });

  app.delete('/api/rooms/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = asRecord(request.params);
    const id = typeof params.id === 'string' ? params.id : '';
    const strategy = readOrphanStrategy(request.query);
    await roomOr404(deps.db, id);

    // Lock, conteggio, spostamento/cancellazione dei dispositivi e DELETE della
    // stanza vivono in un'unica transazione: o passano tutti o nessuno.
    const outcome = await deps.db.deleteRoom(id, strategy);

    switch (outcome.status) {
      case 'not_found':
        // Cancellata da un altro pannello tra la lettura e il lock.
        throw new HttpError(404, 'ROOM_NOT_FOUND', 'Stanza non trovata');
      case 'not_empty':
        throw new HttpError(
          409,
          'ROOM_NOT_EMPTY',
          `La stanza contiene ${outcome.devices} dispositivi: usa ?orphanStrategy=unassign|cascade oppure spostali prima`,
          { devices: outcome.devices },
        );
      case 'unassigned_room_missing':
        throw new HttpError(
          409,
          'UNASSIGNED_ROOM_MISSING',
          `Impossibile spostare ${outcome.devices} dispositivi: la stanza "${UNASSIGNED_ROOM_ID}" non esiste`,
          { devices: outcome.devices },
        );
      case 'deleted':
        // Un solo evento: il client invalida l'intera topologia (stanze,
        // dispositivi e planimetria) e i device a cascata spariscono con lei.
        announce(request, deps, 'room', 'deleted', id);
        return reply.code(204).send();
    }
  });

  app.post('/api/devices', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = parseSchema(CreateDeviceSchema, request.body, 'Dispositivo non valido');
    const id = resolveId(parsed.id, parsed.name);
    const input = deviceInput(parsed, id);
    if (await deps.db.findDeviceById(id)) {
      throw new HttpError(409, 'DEVICE_EXISTS', 'Esiste già un dispositivo con questo id');
    }
    if (!(await deps.db.findRoomById(input.roomId))) {
      throw new HttpError(400, 'ROOM_NOT_FOUND', 'La stanza indicata non esiste', {
        field: 'roomId',
      });
    }
    await deps.db.createDevice({
      id,
      ...input,
      fieldMap: input.fieldMap ?? null,
      metadata: input.metadata ?? {},
    });
    announce(request, deps, 'device', 'created', id);
    return reply.code(201).send({ device: toDevice(await deviceOr404(deps.db, id)) });
  });

  app.patch('/api/devices/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = asRecord(request.params);
    const id = typeof params.id === 'string' ? params.id : '';
    const existing = await deviceOr404(deps.db, id);
    const patch: DeviceUpdate = parsePatch(
      UpdateDeviceSchema,
      request.body,
      'Dispositivo non valido',
    );

    // Solo se il payload sposta davvero il device si verifica la destinazione:
    // un PATCH che tocca solo il nome non deve fallire per una stanza non
    // citata nella richiesta.
    if (patch.roomId !== undefined && !(await deps.db.findRoomById(patch.roomId))) {
      throw new HttpError(400, 'ROOM_NOT_FOUND', 'La stanza indicata non esiste', {
        field: 'roomId',
      });
    }

    await deps.db.updateDevice(id, patch);
    const reordered =
      patch.displayOrder !== undefined && patch.displayOrder !== existing.display_order;
    announce(request, deps, 'device', reordered ? 'reordered' : 'updated', id);
    return reply.send({ device: toDevice(await deviceOr404(deps.db, id)) });
  });

  app.delete('/api/devices/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = asRecord(request.params);
    const id = typeof params.id === 'string' ? params.id : '';
    await deviceOr404(deps.db, id);
    await deps.db.deleteDevice(id);
    announce(request, deps, 'device', 'deleted', id);
    return reply.code(204).send();
  });

  app.post('/api/scenarios', { preHandler: adminOnly }, async (request, reply) => {
    const input = scenarioInput(
      parseSchema(CreateScenarioSchema, request.body, 'Scenario non valido'),
    );
    if (await deps.db.findScenarioById(input.id)) {
      throw new HttpError(409, 'SCENARIO_EXISTS', 'Esiste già uno scenario con questo id');
    }
    await deps.db.createScenario(input);
    announce(request, deps, 'scenario', 'created', input.id);
    return reply
      .code(201)
      .send({ scenario: toScenario(await scenarioOr404(deps.db, input.id)) });
  });

  app.patch('/api/scenarios/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = asRecord(request.params);
    const id = typeof params.id === 'string' ? params.id : '';
    const existing = await scenarioOr404(deps.db, id);
    // Lo scenario si aggiorna in blocco: lo schema di creazione è anche lo
    // schema del replace, quindi vale la stessa regola strict sulle chiavi.
    const input = scenarioInput(
      parseSchema(CreateScenarioSchema, request.body, 'Scenario non valido'),
    );
    await deps.db.updateScenario(id, {
      name: input.name,
      description: input.description,
      icon: input.icon,
      protected: input.protected,
      actions: input.actions,
      displayOrder: input.displayOrder,
    });
    announce(
      request,
      deps,
      'scenario',
      input.displayOrder !== existing.display_order ? 'reordered' : 'updated',
      id,
    );
    return reply.send({ scenario: toScenario(await scenarioOr404(deps.db, id)) });
  });

  app.delete('/api/scenarios/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = asRecord(request.params);
    const id = typeof params.id === 'string' ? params.id : '';
    await scenarioOr404(deps.db, id);
    await deps.db.deleteScenario(id);
    announce(request, deps, 'scenario', 'deleted', id);
    return reply.code(204).send();
  });
}
