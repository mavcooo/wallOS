import type { DeviceRow } from '../types.js';

/**
 * Traduzione di un'azione astratta nel comando del firmware, lato server.
 *
 * È il gemello di `encode()` degli adapter del pannello
 * (`src/mqtt/adapters/*`): un'automazione deve parlare al dispositivo lo stesso
 * dialetto di un tocco sullo schermo, altrimenti lo stesso device riceverebbe
 * due comandi diversi a seconda di chi lo comanda. I due codificatori restano
 * separati perché uno gira nel browser e l'altro nel processo Node, ma il test
 * `src/mqtt/adapters/commandEncoder.parity.test.ts` li confronta caso per caso:
 * se un dialetto cambia da una parte sola, la suite lo segnala.
 *
 * Le uniche differenze volute rispetto al client:
 * - `commandTopic` assente → `null` invece di un topic vuoto (il motore lo
 *   registra come passo saltato, non pubblica sul base topic);
 * - l'envelope RPC Shelly dichiara `src: "wallos-engine"` invece di
 *   `domus-kiosk` (è un altro client, il broker lo deve poter distinguere).
 */

/** Kinds ammessi dal pannello: i passi di scenario li usano così. */
export type CommandTargetKind = DeviceRow['type'];

/** Canale di comando di un'entità scoperta via Home Assistant Discovery. */
export interface DiscoveryCommandChannel {
  field: string;
  topic: string;
  payloadOn?: string;
  payloadOff?: string;
  scale?: number;
}

/** Tutto ciò che serve a tradurre un comando: metadati, non telemetria. */
export interface CommandTarget {
  id: string;
  adapter: string;
  kind: CommandTargetKind;
  commandTopic: string | null;
  fieldMap: Record<string, string> | null;
  discoveryCommands: DiscoveryCommandChannel[] | null;
}

/** Azione astratta, gemella di `ControlAction` in `src/types/device.ts`. */
export type DeviceAction =
  | { type: 'power'; on: boolean }
  | { type: 'brightness'; brightness: number }
  | { type: 'colorTemp'; kelvin: number }
  | { type: 'targetTemp'; targetTemp: number }
  | { type: 'climateMode'; mode: string }
  | { type: 'fanSpeed'; fanSpeed: string }
  | { type: 'swing'; swing: boolean }
  | { type: 'volume'; volume: number }
  | { type: 'source'; source: string };

export interface EncodedDeviceCommand {
  topic: string;
  payload: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function commandTopic(target: CommandTarget, suffix = ''): string | null {
  const topic = target.commandTopic?.trim();
  if (!topic) return null;
  return `${topic}${suffix}`;
}

function jsonCommand(target: CommandTarget, payload: Record<string, unknown>): EncodedDeviceCommand | null {
  const topic = commandTopic(target);
  return topic === null ? null : { topic, payload: JSON.stringify(payload) };
}

/** Vantaggio Home Assistant: i canali di comando del topic di discovery. */
function discoveryChannel(target: CommandTarget, field: string): DiscoveryCommandChannel | undefined {
  return target.discoveryCommands?.find((entry) => entry.field === field);
}

/** Tasmota espone `POWER`, `POWER1`, `POWER2`… per i relè multipli. */
function tasmotaPowerField(target: CommandTarget): string {
  const relay = Number.parseInt(target.fieldMap?.['relay'] ?? '1', 10);
  return Number.isFinite(relay) && relay > 1 ? `POWER${relay}` : 'POWER';
}

function shellyChannel(target: CommandTarget): number {
  const parsed = Number.parseInt(target.fieldMap?.['channel'] ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shellyRpc(
  target: CommandTarget,
  method: string,
  params: Record<string, unknown>,
): EncodedDeviceCommand | null {
  const topic = commandTopic(target);
  if (topic === null) return null;
  return {
    topic,
    payload: JSON.stringify({
      id: Date.now() % 100_000,
      src: 'wallos-engine',
      method,
      params,
    }),
  };
}

/** Zigbee2MQTT: un oggetto JSON sul topic `/set`. */
function zigbee2mqttCommand(target: CommandTarget, action: DeviceAction): EncodedDeviceCommand | null {
  switch (action.type) {
    case 'power':
      return jsonCommand(target, { state: action.on ? 'ON' : 'OFF' });
    case 'brightness':
      return jsonCommand(target, {
        state: action.brightness > 0 ? 'ON' : 'OFF',
        brightness: Math.round(clamp(action.brightness, 0, 100) * 2.54),
      });
    case 'colorTemp':
      return jsonCommand(target, { color_temp: Math.round(1_000_000 / action.kelvin) });
    case 'targetTemp':
      return jsonCommand(target, { occupied_heating_setpoint: action.targetTemp });
    case 'climateMode':
      return jsonCommand(target, { system_mode: action.mode });
    case 'fanSpeed':
      return jsonCommand(target, { fan_mode: action.fanSpeed });
    case 'swing':
      return jsonCommand(target, { swing_mode: action.swing ? 'on' : 'off' });
    case 'volume':
      return jsonCommand(target, { volume: Math.round(action.volume) });
    case 'source':
      return jsonCommand(target, { source: action.source });
  }
}

/** Tasmota: un topic per comando (`POWER`, `Dimmer`, `Setpoint`, `Mode`). */
function tasmotaCommand(target: CommandTarget, action: DeviceAction): EncodedDeviceCommand | null {
  switch (action.type) {
    case 'power': {
      const topic = commandTopic(target, `/${tasmotaPowerField(target)}`);
      return topic === null ? null : { topic, payload: action.on ? 'ON' : 'OFF' };
    }
    case 'brightness': {
      const topic = commandTopic(target, '/Dimmer');
      return topic === null
        ? null
        : { topic, payload: String(Math.round(clamp(action.brightness, 0, 100))) };
    }
    case 'targetTemp': {
      const topic = commandTopic(target, '/Setpoint');
      return topic === null ? null : { topic, payload: String(action.targetTemp) };
    }
    case 'climateMode': {
      const topic = commandTopic(target, '/Mode');
      return topic === null ? null : { topic, payload: action.mode };
    }
    default:
      // Luminosità colore, ventola e sorgente non esistono nel dialetto Tasmota usato dal pannello.
      return null;
  }
}

function shellyCommand(target: CommandTarget, action: DeviceAction): EncodedDeviceCommand | null {
  const id = shellyChannel(target);
  switch (action.type) {
    case 'power':
      return shellyRpc(target, target.kind === 'light' ? 'Light.Set' : 'Switch.Set', {
        id,
        on: action.on,
      });
    case 'brightness':
      return shellyRpc(target, 'Light.Set', {
        id,
        on: action.brightness > 0,
        brightness: Math.round(clamp(action.brightness, 0, 100)),
      });
    case 'targetTemp':
      return shellyRpc(target, 'Thermostat.SetConfig', {
        id,
        config: { target_C: action.targetTemp },
      });
    default:
      return null;
  }
}

/** Custom JSON: chiavi rinominabili con il prefisso `cmd.` nel `field_map`. */
function customJsonCommand(target: CommandTarget, action: DeviceAction): EncodedDeviceCommand | null {
  const map = target.fieldMap ?? {};
  const key = (field: string, fallback: string): string => map[`cmd.${field}`] ?? fallback;
  switch (action.type) {
    case 'power':
      return jsonCommand(target, { [key('power', 'on')]: action.on });
    case 'brightness':
      return jsonCommand(target, {
        [key('power', 'on')]: action.brightness > 0,
        [key('brightness', 'brightness')]: Math.round(action.brightness),
      });
    case 'targetTemp':
      return jsonCommand(target, { [key('targetTemp', 'targetTemp')]: action.targetTemp });
    case 'climateMode':
      return jsonCommand(target, { [key('mode', 'mode')]: action.mode });
    case 'volume':
      return jsonCommand(target, { [key('volume', 'volume')]: Math.round(action.volume) });
    default:
      return null;
  }
}

function haDiscoveryCommand(target: CommandTarget, action: DeviceAction): EncodedDeviceCommand | null {
  switch (action.type) {
    case 'power': {
      const channel = discoveryChannel(target, 'on');
      if (!channel) return null;
      return {
        topic: channel.topic,
        payload: action.on ? (channel.payloadOn ?? 'ON') : (channel.payloadOff ?? 'OFF'),
      };
    }
    case 'brightness': {
      const channel = discoveryChannel(target, 'brightness');
      if (!channel) return null;
      const scale = channel.scale && channel.scale > 0 ? channel.scale : 255;
      return {
        topic: channel.topic,
        payload: String(Math.round((clamp(action.brightness, 0, 100) / 100) * scale)),
      };
    }
    case 'colorTemp': {
      const channel = discoveryChannel(target, 'colorTemp');
      if (!channel) return null;
      return {
        topic: channel.topic,
        payload: String(Math.round(1_000_000 / Math.max(1, action.kelvin))),
      };
    }
    case 'targetTemp': {
      const channel = discoveryChannel(target, 'targetTemp');
      return channel ? { topic: channel.topic, payload: String(action.targetTemp) } : null;
    }
    case 'climateMode': {
      const channel = discoveryChannel(target, 'mode');
      return channel ? { topic: channel.topic, payload: action.mode } : null;
    }
    default:
      // Volume, sorgente, ventola e oscillazione non hanno un canale generico.
      return null;
  }
}

/**
 * Traduce l'azione nel comando del firmware. `null` = il dispositivo non
 * supporta quell'azione (o non ha un topic di comando): il motore lo registra
 * come passo saltato, senza far fallire l'intera regola.
 */
export function encodeDeviceAction(
  target: CommandTarget,
  action: DeviceAction,
): EncodedDeviceCommand | null {
  switch (target.adapter) {
    case 'tasmota':
      return tasmotaCommand(target, action);
    case 'shelly':
      return shellyCommand(target, action);
    case 'custom-json':
      return customJsonCommand(target, action);
    case 'ha-discovery':
      return haDiscoveryCommand(target, action);
    case 'zigbee2mqtt':
    default:
      return zigbee2mqttCommand(target, action);
  }
}

/** `metadata` arriva da jsonb (oggetto) ma è difensivo verso le stringhe. */
function readMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Riga di `devices` → bersaglio dei comandi (i canali di discovery stanno in `metadata`). */
export function commandTargetFromRow(row: DeviceRow): CommandTarget {
  const meta = readMetadata(row.metadata);
  const discovery =
    typeof meta['discovery'] === 'object' && meta['discovery'] !== null
      ? (meta['discovery'] as { commands?: unknown })
      : null;
  const commands = Array.isArray(discovery?.commands)
    ? (discovery?.commands as DiscoveryCommandChannel[])
    : null;

  return {
    id: row.id,
    adapter: row.adapter,
    kind: row.type,
    commandTopic: row.command_topic,
    fieldMap: row.field_map,
    discoveryCommands: commands,
  };
}
