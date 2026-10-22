import type {
  ClimateMode,
  DecodedState,
  Device,
  DiscoveryStateChannel,
} from '@/types/device';

import { clamp, isOn, num, parseJson } from './types';
import type { DeviceAdapter } from './types';

const CLIMATE_MODES: readonly ClimateMode[] = [
  'off',
  'heat',
  'cool',
  'auto',
  'fan_only',
  'dry',
];

/**
 * Subset Jinja supportato: `{{ value }}`, `{{ value_json }}` e
 * `{{ value_json.temperatura.attuale }}`. Tutto il resto ricade sul payload
 * grezzo: meglio un valore non convertito che un widget vuoto.
 */
function readPayload(template: string | undefined, payload: string): unknown {
  const text = payload.trim();
  if (!template) return text;

  const expression = template.replace(/\{\{|\}\}/g, '').trim();
  if (expression === 'value') return text;
  if (expression === 'value_json') return parseJson(text) ?? text;

  const path = /^value_json\.(.+)$/.exec(expression)?.[1];
  if (!path) return text;

  let current: unknown = parseJson(text);
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return text;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? text;
}

function coerce(channel: DiscoveryStateChannel, payload: string): string | number | boolean | undefined {
  const value = readPayload(channel.template, payload);

  switch (channel.kind) {
    case 'boolean': {
      const text = String(value).trim().toLowerCase();
      if (channel.payloadOn && text === channel.payloadOn.trim().toLowerCase()) return true;
      if (channel.payloadOff && text === channel.payloadOff.trim().toLowerCase()) return false;
      return isOn(value);
    }
    case 'number':
      return num(value);
    case 'brightness': {
      const raw = num(value);
      if (raw === undefined) return undefined;
      const scale = channel.scale && channel.scale > 0 ? channel.scale : 255;
      return Math.round(clamp((raw / scale) * 100, 0, 100));
    }
    case 'mired': {
      const raw = num(value);
      return raw && raw > 0 ? Math.round(1_000_000 / raw) : undefined;
    }
    case 'text': {
      const text = String(value).trim();
      return text.length > 0 ? text : undefined;
    }
  }
}

function decodeChannel(
  device: Device,
  topic: string,
  payload: string,
): DecodedState | null {
  const discovery = device.discovery;
  if (!discovery) return null;

  const channel = discovery.state.find((entry) => entry.topic === topic);
  if (!channel) return null;

  const value = coerce(channel, payload);
  if (value === undefined) return null;

  switch (device.kind) {
    case 'light':
      if (channel.field === 'on') return { kind: 'light', state: { on: value === true } };
      if (channel.field === 'brightness') {
        return { kind: 'light', state: { brightness: Number(value) } };
      }
      if (channel.field === 'colorTemp') {
        return { kind: 'light', state: { colorTemp: Number(value) } };
      }
      return null;
    case 'climate':
      if (channel.field === 'currentTemp') {
        return { kind: 'climate', state: { currentTemp: Number(value) } };
      }
      if (channel.field === 'targetTemp') {
        return { kind: 'climate', state: { targetTemp: Number(value) } };
      }
      if (channel.field === 'mode') {
        const mode = CLIMATE_MODES.find((candidate) => candidate === String(value));
        if (!mode) return null;
        return {
          kind: 'climate',
          state: { mode, action: mode === 'off' ? 'idle' : device.state.action },
        };
      }
      return null;
    case 'power':
      return channel.field === 'on' ? { kind: 'power', state: { on: value === true } } : null;
    case 'sensor': {
      if (channel.field !== 'value') return null;
      if (typeof value === 'boolean') return { kind: 'sensor', state: { value } };
      const numeric = Number(value);
      return Number.isFinite(numeric) ? { kind: 'sensor', state: { value: numeric } } : null;
    }
    case 'media':
      return null;
  }
}

export const haDiscoveryAdapter: DeviceAdapter = {
  label: 'Home Assistant Discovery',
  decode({ device, topic, payload }) {
    return decodeChannel(device, topic, payload);
  },
  encode(device, action) {
    const commands = device.discovery?.commands ?? [];
    const channelFor = (field: string) => commands.find((entry) => entry.field === field);

    switch (action.type) {
      case 'power': {
        const channel = channelFor('on');
        if (!channel) return null;
        return {
          topic: channel.topic,
          payload: action.on ? (channel.payloadOn ?? 'ON') : (channel.payloadOff ?? 'OFF'),
          qos: 0,
        };
      }
      case 'brightness': {
        const channel = channelFor('brightness');
        if (!channel) return null;
        const scale = channel.scale && channel.scale > 0 ? channel.scale : 255;
        return {
          topic: channel.topic,
          payload: String(Math.round((clamp(action.brightness, 0, 100) / 100) * scale)),
          qos: 0,
        };
      }
      case 'colorTemp': {
        const channel = channelFor('colorTemp');
        if (!channel) return null;
        return {
          topic: channel.topic,
          payload: String(Math.round(1_000_000 / Math.max(1, action.kelvin))),
          qos: 0,
        };
      }
      case 'targetTemp': {
        const channel = channelFor('targetTemp');
        return channel ? { topic: channel.topic, payload: String(action.targetTemp), qos: 0 } : null;
      }
      case 'climateMode': {
        const channel = channelFor('mode');
        return channel ? { topic: channel.topic, payload: action.mode, qos: 0 } : null;
      }
      // Volume, sorgente, ventola e oscillazione non hanno un canale discovery
      // generico: l'azione viene rifiutata dall'adapter (toast in `sendAction`).
      default:
        return null;
    }
  },
};
