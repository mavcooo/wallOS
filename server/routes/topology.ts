import type { FastifyInstance, FastifyRequest } from 'fastify';

import { normalizeGridLayout, normalizePinPosition, type Database, type DeviceFields } from '../db.js';
import { HttpError, asRecord, readBoolean, readString } from '../http.js';
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
function resolveId(body: Record<string, unknown>, label: string): string {
  const explicit = readString(body, 'id', 64);
  const id = explicit ?? slugify(label);
  if (!SLUG_RE.test(id)) {
    throw invalid(
      'L’id deve essere uno slug (minuscole, cifre, - _ :) e iniziare con lettera o cifra',
      'id',
    );
  }
  return id;
}

function requiredText(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
  label: string,
): string {
  const value = readString(body, key, maxLength);
  if (!value) throw invalid(`${label} è obbligatorio`, key);
  return value;
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
  label: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') return null;
  const text = readString(body, key, maxLength);
  if (!text) throw invalid(`${label} non valido`, key);
  return text;
}

function integerField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback = 0,
): number {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(`${key} deve essere un intero tra ${min} e ${max}`, key);
  }
  return value as number;
}

function booleanField(
  body: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  if (body[key] === undefined || body[key] === null) return fallback;
  const value = readBoolean(body, key);
  if (value === null) throw invalid(`${key} deve essere booleano`, key);
  return value;
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

function jsonObject(
  body: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} deve essere un oggetto JSON`, key);
  }
  if (JSON.stringify(value).length > 8_192) {
    throw invalid(`${label} supera gli 8 kB`, key);
  }
  return value as Record<string, unknown>;
}

function stringMap(
  body: Record<string, unknown>,
  key: string,
): Record<string, string> | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${key} deve essere un oggetto { campo: percorso }`, key);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw invalid(`${key} ha troppi campi`, key);
  const map: Record<string, string> = {};
  for (const [field, path] of entries) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 256) {
      throw invalid(`${key}.${field} deve essere un percorso stringa`, key);
    }
    map[field] = path;
  }
  return map;
}

function roomInput(
  body: Record<string, unknown>,
): { id: string; name: string; shortLabel: string | null; icon: string; displayOrder: number } {
  const name = requiredText(body, 'name', 80, 'Il nome della stanza');
  return {
    id: resolveId(body, name),
    name,
    shortLabel: optionalText(body, 'shortLabel', 24, 'L’etichetta breve'),
    icon: readString(body, 'icon', 40) ?? 'home',
    displayOrder: integerField(body, 'displayOrder', 0, 9_999),
  };
}

function streamUrl(
  body: Record<string, unknown>,
  key: string,
  label: string,
  allowWebrtc = true,
): string | null {
  const value = optionalText(body, key, 1_024, label);
  if (value === null) return null;
  const pattern = allowWebrtc ? /^(https?|webrtc):\/\/[^\s]+$/i : /^https?:\/\/[^\s]+$/i;
  if (!pattern.test(value)) {
    throw invalid(
      `${label}: usa un URL ${allowWebrtc ? 'http(s) o webrtc://' : 'http(s)'}`,
      key,
    );
  }
  return value;
}

function deviceInput(body: Record<string, unknown>): DeviceFields {
  const name = requiredText(body, 'name', 80, 'Il nome del dispositivo');
  const type = enumField(body, 'type', DEVICE_TYPES, 'light');
  const isCamera = type === 'camera';
  const stream = isCamera ? streamUrl(body, 'streamUrl', 'L’URL del flusso') : null;
  if (isCamera && !stream) {
    throw invalid('L’URL del flusso è obbligatorio per una telecamera', 'streamUrl');
  }

  return {
    roomId: requiredText(body, 'roomId', 64, 'La stanza'),
    name,
    type,
    adapter: enumField(body, 'adapter', ADAPTERS, isCamera ? 'custom-json' : 'zigbee2mqtt'),
    model: optionalText(body, 'model', 80, 'Il modello'),
    stateTopic: isCamera
      ? (readString(body, 'stateTopic', 512) ?? `camera/${resolveId(body, name)}`)
      : requiredText(body, 'stateTopic', 512, 'Il topic di stato'),
    commandTopic: isCamera
      ? null
      : optionalText(body, 'commandTopic', 512, 'Il topic di comando'),
    availabilityTopic: isCamera
      ? null
      : optionalText(body, 'availabilityTopic', 512, 'Il topic di availability'),
    streamUrl: stream,
    snapshotUrl: isCamera
      ? streamUrl(body, 'snapshotUrl', 'L’URL dello snapshot', false)
      : null,
    streamProtocol: isCamera
      ? enumField<CameraProtocol>(body, 'streamProtocol', CAMERA_PROTOCOLS, 'auto')
      : null,
    aspectRatio: isCamera
      ? enumField<CameraAspectRatio>(body, 'aspectRatio', ASPECT_RATIOS, '16:9')
      : null,
    favorite: booleanField(body, 'favorite'),
    protected: booleanField(body, 'protected'),
    displayOrder: integerField(body, 'displayOrder', 0, 9_999),
    ...(body.fieldMap !== undefined ? { fieldMap: stringMap(body, 'fieldMap') } : {}),
    ...(body.metadata !== undefined ? { metadata: jsonObject(body, 'metadata', 'metadata') } : {}),
  };
}

function scenarioInput(
  body: Record<string, unknown>,
): { id: string; name: string; description: string; icon: string; protected: boolean; actions: unknown; displayOrder: number } {
  const name = requiredText(body, 'label', 80, 'Il nome dello scenario');
  return {
    id: resolveId(body, name),
    name,
    description: readString(body, 'description', 240) ?? '',
    icon: readString(body, 'icon', 40) ?? 'sparkles',
    protected: booleanField(body, 'protected'),
    actions: scenarioSteps(body),
    displayOrder: integerField(body, 'displayOrder', 0, 9_999),
  };
}

/** Valida e normalizza i passi: un JSON arbitrario non entra nel DB. */
function scenarioSteps(body: Record<string, unknown>): unknown[] {
  const raw = body.actions;
  if (!Array.isArray(raw)) throw invalid('actions deve essere un array di passi', 'actions');
  if (raw.length > 50) throw invalid('Uno scenario può avere al massimo 50 passi', 'actions');

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
    const input = roomInput(asRecord(request.body));
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
    const existing = await roomOr404(deps.db, id);
    const input = roomInput(asRecord(request.body));
    await deps.db.updateRoom(id, {
      name: input.name,
      shortLabel: input.shortLabel,
      icon: input.icon,
      displayOrder: input.displayOrder,
    });
    // Solo l'ordine cambia → riordino; il resto è un aggiornamento normale.
    announce(
      request,
      deps,
      'room',
      input.displayOrder !== existing.display_order ? 'reordered' : 'updated',
      id,
    );
    return reply.send({ room: toRoom(await roomOr404(deps.db, id)) });
  });

  app.delete('/api/rooms/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = asRecord(request.params);
    const id = typeof params.id === 'string' ? params.id : '';
    await roomOr404(deps.db, id);
    const devices = await deps.db.countDevicesInRoom(id);
    if (devices > 0) {
      throw new HttpError(
        409,
        'ROOM_NOT_EMPTY',
        `La stanza contiene ${devices} dispositivi: spostali o eliminali prima`,
      );
    }
    await deps.db.deleteRoom(id);
    announce(request, deps, 'room', 'deleted', id);
    return reply.code(204).send();
  });

  app.post('/api/devices', { preHandler: adminOnly }, async (request, reply) => {
    const body = asRecord(request.body);
    const input = deviceInput(body);
    const id = resolveId(body, input.name);
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
    const input = deviceInput(asRecord(request.body));
    if (!(await deps.db.findRoomById(input.roomId))) {
      throw new HttpError(400, 'ROOM_NOT_FOUND', 'La stanza indicata non esiste', {
        field: 'roomId',
      });
    }
    // fieldMap/metadata assenti = il valore corrente resta intatto (stato runtime).
    await deps.db.updateDevice(id, input);
    announce(
      request,
      deps,
      'device',
      input.displayOrder !== existing.display_order ? 'reordered' : 'updated',
      id,
    );
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
    const input = scenarioInput(asRecord(request.body));
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
    const input = scenarioInput(asRecord(request.body));
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
