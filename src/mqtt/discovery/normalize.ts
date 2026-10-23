import { UNASSIGNED_ROOM_ID, roomIdFromLabel } from '@/lib/rooms';
import type {
  ClimateDevice,
  Device,
  DeviceDiscovery,
  DiscoveryAvailability,
  DiscoveryCommandChannel,
  DiscoveryStateChannel,
  HaComponent,
  SensorDevice,
  SensorType,
} from '@/types/device';

import type { HaAvailabilityEntry, HaDiscoveryConfig } from './types';

const SUPPORTED: readonly HaComponent[] = ['light', 'switch', 'sensor', 'binary_sensor', 'climate'];

/** Un annuncio riconosciuto: l'entità e l'id del device che ne deriva. */
export interface DiscoveryTopicRef {
  prefix: string;
  component: string;
  /** Ramo opzionale `<node_id>` (dispositivi multi-canale). */
  nodeId?: string;
  objectId: string;
  /** Id stabile dell'entità, ricavato dal topic (base per la deletion). */
  entityId: string;
}

/**
 * `<prefix>/<component>/[<node_id>/]<object_id>/config`.
 * L'id non usa `unique_id` (può mancare e non è ricavabile in deletion):
 * derivare tutto dal topic garantisce che creazione e rimozione coincidano.
 */
export function parseDiscoveryTopic(
  topic: string,
  prefixes: readonly string[],
): DiscoveryTopicRef | null {
  const parts = topic.split('/');
  if (parts.length < 4) return null;

  const prefix = parts[0];
  const component = parts[1];
  const objectId = parts[parts.length - 2];
  const tail = parts[parts.length - 1];
  if (!prefix || !component || !objectId || tail !== 'config') return null;
  if (!prefixes.includes(prefix)) return null;

  const nodeId = parts.length > 4 ? parts.slice(2, -2).join('/') : undefined;
  const entityId = nodeId
    ? `ha:${component}:${nodeId}:${objectId}`
    : `ha:${component}:${objectId}`;

  return { prefix, component, objectId, entityId, ...(nodeId ? { nodeId } : {}) };
}

function isComponent(value: string): value is HaComponent {
  return (SUPPORTED as readonly string[]).includes(value);
}

const SENSOR_TYPES: Readonly<Record<string, SensorType>> = {
  temperature: 'temperature',
  humidity: 'humidity',
  carbon_dioxide: 'co2',
  co2: 'co2',
  illuminance: 'illuminance',
  power: 'power',
  energy: 'energy',
};

const BINARY_TYPES: Readonly<Record<string, SensorType>> = {
  smoke: 'smoke',
  door: 'contact',
  window: 'contact',
  garage_door: 'contact',
  opening: 'contact',
  motion: 'motion',
  occupancy: 'motion',
  presence: 'motion',
};

const DEFAULT_UNITS: Readonly<Partial<Record<SensorType, string>>> = {
  temperature: '°C',
  humidity: '%',
  co2: 'ppm',
  illuminance: 'lx',
  power: 'W',
  energy: 'kWh',
};

/** Heuristica sull'unità per sensori che non dichiarano `device_class`. */
function sensorTypeFromUnit(unit: string): SensorType | null {
  switch (unit.trim()) {
    case '°C':
    case 'C':
      return 'temperature';
    case '%':
      return 'humidity';
    case 'ppm':
      return 'co2';
    case 'W':
    case 'kW':
      return 'power';
    case 'kWh':
    case 'Wh':
      return 'energy';
    case 'lx':
    case 'lm':
      return 'illuminance';
    default:
      return null;
  }
}

function normalizeAvailability(config: HaDiscoveryConfig): DiscoveryAvailability[] {
  const entries: HaAvailabilityEntry[] = config.availability
    ? Array.isArray(config.availability)
      ? config.availability
      : [config.availability]
    : config.availability_topic
      ? [
          {
            topic: config.availability_topic,
            payload_available: config.payload_available,
            payload_not_available: config.payload_not_available,
          },
        ]
      : [];

  return entries.flatMap((entry) => {
    const topic = entry.topic?.trim();
    if (!topic) return [];
    return [
      {
        topic,
        ...(entry.payload_available ? { payloadAvailable: entry.payload_available } : {}),
        ...(entry.payload_not_available
          ? { payloadNotAvailable: entry.payload_not_available }
          : {}),
      },
    ];
  });
}

function stateChannel(
  topic: string | undefined,
  field: DiscoveryStateChannel['field'],
  kind: DiscoveryStateChannel['kind'],
  extra: Partial<Omit<DiscoveryStateChannel, 'topic' | 'field' | 'kind'>> = {},
): DiscoveryStateChannel[] {
  const clean = topic?.trim();
  return clean ? [{ topic: clean, field, kind, ...extra }] : [];
}

function commandChannel(
  topic: string | undefined,
  field: DiscoveryCommandChannel['field'],
  kind: DiscoveryCommandChannel['kind'],
  extra: Partial<Omit<DiscoveryCommandChannel, 'topic' | 'field' | 'kind'>> = {},
): DiscoveryCommandChannel[] {
  const clean = topic?.trim();
  return clean ? [{ topic: clean, field, kind, ...extra }] : [];
}

function displayName(config: HaDiscoveryConfig, objectId: string): string {
  const entityName = config.name?.trim();
  if (entityName) return entityName;
  const deviceName = config.device?.name?.trim();
  return deviceName || objectId;
}

function modelOf(config: HaDiscoveryConfig): string {
  const parts = [config.device?.manufacturer?.trim(), config.device?.model?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(' ') : 'Home Assistant';
}

/** I mired sono l'inverso dei kelvin: `min_mireds` è il fondo scala caldo. */
function colorTempRange(config: HaDiscoveryConfig): readonly [number, number] {
  const minMireds = config.min_mireds;
  const maxMireds = config.max_mireds;
  if (!minMireds || !maxMireds || minMireds <= 0 || maxMireds <= 0) return [2200, 6500];
  return [Math.round(1_000_000 / maxMireds), Math.round(1_000_000 / minMireds)];
}

export interface NormalizeResult {
  entityId: string;
  device: Device;
}

/**
 * Trasforma un annuncio HA Discovery nel modello interno.
 * `null` = componente non supportato, sensore non riconoscibile o annuncio
 * senza alcun topic utilizzabile.
 */
export function normalizeDiscovery(
  ref: DiscoveryTopicRef,
  config: HaDiscoveryConfig,
): NormalizeResult | null {
  if (!isComponent(ref.component)) return null;

  const component = ref.component;
  const area = config.device?.suggested_area?.trim();
  const payloadOn = config.payload_on ?? 'ON';
  const payloadOff = config.payload_off ?? 'OFF';
  const sensorType =
    component === 'sensor'
      ? (SENSOR_TYPES[config.device_class ?? ''] ??
        sensorTypeFromUnit(config.unit_of_measurement ?? ''))
      : null;
  if (component === 'sensor' && !sensorType) return null;

  const state: DiscoveryStateChannel[] = [];
  const commands: DiscoveryCommandChannel[] = [];

  switch (component) {
    case 'light': {
      state.push(...stateChannel(config.state_topic, 'on', 'boolean', { payloadOn, payloadOff }));
      state.push(
        ...stateChannel(config.brightness_state_topic, 'brightness', 'brightness', {
          scale: config.brightness_scale ?? 255,
        }),
      );
      state.push(...stateChannel(config.color_temp_state_topic, 'colorTemp', 'mired'));
      commands.push(
        ...commandChannel(config.command_topic, 'on', 'raw', { payloadOn, payloadOff }),
      );
      commands.push(
        ...commandChannel(config.brightness_command_topic, 'brightness', 'brightness', {
          scale: config.brightness_scale ?? 255,
        }),
      );
      commands.push(...commandChannel(config.color_temp_command_topic, 'colorTemp', 'mired'));
      break;
    }
    case 'switch':
      state.push(...stateChannel(config.state_topic, 'on', 'boolean', { payloadOn, payloadOff }));
      commands.push(
        ...commandChannel(config.command_topic, 'on', 'raw', { payloadOn, payloadOff }),
      );
      break;
    case 'climate':
      state.push(...stateChannel(config.current_temperature_topic, 'currentTemp', 'number'));
      state.push(...stateChannel(config.temperature_state_topic, 'targetTemp', 'number'));
      state.push(...stateChannel(config.mode_state_topic, 'mode', 'text'));
      commands.push(...commandChannel(config.temperature_command_topic, 'targetTemp', 'raw'));
      commands.push(...commandChannel(config.mode_command_topic, 'mode', 'raw'));
      break;
    case 'sensor':
      state.push(
        ...stateChannel(config.state_topic, 'value', 'number', {
          ...(config.value_template ? { template: config.value_template } : {}),
        }),
      );
      break;
    case 'binary_sensor':
      state.push(
        ...stateChannel(config.state_topic, 'value', 'boolean', {
          payloadOn,
          payloadOff,
          ...(config.value_template ? { template: config.value_template } : {}),
        }),
      );
      break;
  }

  if (state.length === 0 && commands.length === 0) return null;

  const discovery: DeviceDiscovery = {
    entityId: ref.entityId,
    ...(config.unique_id ? { uniqueId: config.unique_id } : {}),
    component,
    configTopic: `${ref.prefix}/${component}/${ref.nodeId ? `${ref.nodeId}/` : ''}${ref.objectId}/config`,
    ...(area ? { area } : {}),
    state,
    commands,
    availability: normalizeAvailability(config),
  };

  const base = {
    id: ref.entityId,
    name: displayName(config, ref.objectId),
    room: area ? roomIdFromLabel(area) : UNASSIGNED_ROOM_ID,
    adapter: 'ha-discovery' as const,
    model: modelOf(config),
    topics: {
      state: state[0]?.topic ?? '',
      ...(commands[0]?.topic ? { command: commands[0].topic } : {}),
      ...(discovery.availability[0]?.topic ? { availability: discovery.availability[0].topic } : {}),
    },
    availability: 'unknown' as const,
    lastSeen: null,
    favorite: false,
    protected: false,
    discovery,
  };

  switch (component) {
    case 'light': {
      const dimmable =
        state.some((channel) => channel.field === 'brightness') ||
        commands.some((command) => command.field === 'brightness');
      const hasColorTemp =
        state.some((channel) => channel.field === 'colorTemp') ||
        commands.some((command) => command.field === 'colorTemp');
      return {
        entityId: ref.entityId,
        device: {
          ...base,
          kind: 'light',
          state: { on: false, brightness: 0, ...(hasColorTemp ? { colorTemp: 2700 } : {}) },
          capabilities: {
            dimmable,
            ...(hasColorTemp ? { colorTempRange: colorTempRange(config) } : {}),
          },
        },
      };
    }
    case 'switch':
      return {
        entityId: ref.entityId,
        device: {
          ...base,
          kind: 'power',
          state: {
            on: false,
            watts: 0,
            voltage: 0,
            current: 0,
            energyTodayKwh: 0,
            energyTotalKwh: 0,
            maxWatts: 2000,
          },
        },
      };
    case 'climate': {
      const climate: ClimateDevice = {
        ...base,
        kind: 'climate',
        state: {
          mode: 'off',
          targetTemp: 20,
          currentTemp: 20,
          fanSpeed: 'auto',
          swing: false,
          action: 'idle',
        },
        minTemp: config.min_temp ?? 7,
        maxTemp: config.max_temp ?? 35,
        tempStep: config.temp_step ?? 0.5,
      };
      return { entityId: ref.entityId, device: climate };
    }
    case 'sensor': {
      const unit = config.unit_of_measurement?.trim() ?? '';
      if (!sensorType) return null;
      const sensor: SensorDevice = {
        ...base,
        kind: 'sensor',
        state: { value: 0, unit: unit || (DEFAULT_UNITS[sensorType] ?? ''), type: sensorType },
      };
      return { entityId: ref.entityId, device: sensor };
    }
    case 'binary_sensor': {
      const sensor: SensorDevice = {
        ...base,
        kind: 'sensor',
        state: {
          value: false,
          unit: '',
          type: BINARY_TYPES[config.device_class ?? ''] ?? 'contact',
        },
      };
      return { entityId: ref.entityId, device: sensor };
    }
  }
}
