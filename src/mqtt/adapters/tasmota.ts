import type { ClimateMode } from '@/types/device';
import { clamp, isOn, num, parseJson } from './types';
import type { DeviceAdapter } from './types';

const MODES: readonly ClimateMode[] = ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry'];

function powerPayload(action: boolean) {
  return action ? 'ON' : 'OFF';
}

/** Tasmota espone `POWER`, `POWER1`, `POWER2`… per i relè multipli. */
function powerField(device: { fieldMap?: Record<string, string> }): string {
  const relay = Number.parseInt(device.fieldMap?.['relay'] ?? '1', 10);
  return Number.isFinite(relay) && relay > 1 ? `POWER${relay}` : 'POWER';
}

export const tasmotaAdapter: DeviceAdapter = {
  label: 'Tasmota',
  decode({ device, payload }) {
    const raw = payload.trim();
    // I topic `stat/<device>/POWER` pubblicano ON/OFF in chiaro.
    const direct = isOn(raw);
    if (direct !== undefined && (device.kind === 'power' || device.kind === 'light')) {
      return device.kind === 'power'
        ? { kind: 'power', state: { on: direct } }
        : {
            kind: 'light',
            state: { on: direct, brightness: direct ? device.state.brightness : 0 },
          };
    }

    const data = parseJson(payload);
    if (!data) return null;

    switch (device.kind) {
      case 'light': {
        const state: { on?: boolean; brightness?: number; colorTemp?: number } = {};
        const on = isOn(data[powerField(device)] ?? data['POWER'] ?? data['POWER1']);
        if (on !== undefined) state.on = on;
        const dimmer = num(data['Dimmer']);
        if (dimmer !== undefined) {
          state.brightness = clamp(dimmer, 0, 100);
          if (dimmer > 0) state.on = true;
        }
        const ct = num(data['CT']);
        if (ct !== undefined) state.colorTemp = Math.round(1_000_000 / clamp(ct, 153, 500));
        return { kind: 'light', state };
      }
      case 'power': {
        const state: {
          on?: boolean;
          watts?: number;
          voltage?: number;
          current?: number;
          energyTodayKwh?: number;
          energyTotalKwh?: number;
        } = {};
        const on = isOn(data[powerField(device)] ?? data['POWER'] ?? data['POWER1']);
        if (on !== undefined) state.on = on;
        const energy = data['ENERGY'];
        if (typeof energy === 'object' && energy !== null) {
          const meter = energy as Record<string, unknown>;
          const watts = num(meter['Power']);
          if (watts !== undefined) state.watts = watts;
          const voltage = num(meter['Voltage']);
          if (voltage !== undefined) state.voltage = voltage;
          const current = num(meter['Current']);
          if (current !== undefined) state.current = current;
          const today = num(meter['Today']);
          if (today !== undefined) state.energyTodayKwh = today;
          const total = num(meter['Total']);
          if (total !== undefined) state.energyTotalKwh = total;
        }
        return { kind: 'power', state };
      }
      case 'climate': {
        const state: {
          targetTemp?: number;
          currentTemp?: number;
          humidity?: number;
          mode?: ClimateMode;
          action?: 'idle' | 'heating' | 'cooling';
        } = {};
        const target = num(data['Setpoint'] ?? data['TEMP']);
        if (target !== undefined) state.targetTemp = target;
        const analog = data['ANALOG'];
        const analogTemp =
          typeof analog === 'object' && analog !== null
            ? num((analog as Record<string, unknown>)['Temperature'])
            : undefined;
        const current = num(data['Temperature']) ?? analogTemp;
        if (current !== undefined) state.currentTemp = current;
        const humidity = num(data['Humidity']);
        if (humidity !== undefined) state.humidity = humidity;
        const mode = MODES.find((candidate) => candidate === data['Mode']);
        if (mode) state.mode = mode;
        const power = isOn(data['POWER']);
        if (power !== undefined) state.action = power ? 'heating' : 'idle';
        return { kind: 'climate', state };
      }
      case 'sensor': {
        const nested = data['ANALOG'] ?? data['ENERGY'];
        const candidates =
          typeof nested === 'object' && nested !== null
            ? (nested as Record<string, unknown>)
            : data;
        const value = num(candidates[device.state.type === 'temperature' ? 'Temperature' : '']);
        if (value !== undefined) return { kind: 'sensor', state: { value } };
        const generic = num(data['Temperature']);
        return generic === undefined ? null : { kind: 'sensor', state: { value: generic } };
      }
      case 'media':
        return null;
    }
  },
  encode(device, action) {
    // Tasmota usa un topic per comando: <base>/POWER, <base>/Dimmer, ...
    const base = device.topics.command ?? '';
    switch (action.type) {
      case 'power':
        return { topic: `${base}/${powerField(device)}`, payload: powerPayload(action.on), qos: 0 };
      case 'brightness':
        return {
          topic: `${base}/Dimmer`,
          payload: String(Math.round(clamp(action.brightness, 0, 100))),
          qos: 0,
        };
      case 'targetTemp':
        return {
          topic: `${base}/Setpoint`,
          payload: String(action.targetTemp),
          qos: 0,
        };
      case 'climateMode':
        return {
          topic: `${base}/Mode`,
          payload: action.mode,
          qos: 0,
        };
      default:
        return null;
    }
  },
};
