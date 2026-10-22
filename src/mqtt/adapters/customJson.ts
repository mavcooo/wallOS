import type { ClimateMode } from '@/types/device';
import { clamp, isOn, jsonCommand, num } from './types';
import type { DeviceAdapter } from './types';

/**
 * Adapter generico per firmware/centraline custom.
 * La mappa dei campi vive nel device (`fieldMap`):
 *   { "on": "relay.state", "brightness": "dimmer.value", "watts": "meter.p" }
 * Per l'encoding si possono ridefinire le chiavi con il prefisso `cmd.`:
 *   { "cmd.power": "relay", "cmd.brightness": "level" }
 */

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

export const customJsonAdapter: DeviceAdapter = {
  label: 'Custom JSON',
  decode({ device, payload }) {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
    if (data === null || typeof data !== 'object') return null;
    const map = device.fieldMap ?? {};
    const pick = (key: string): unknown => {
      const path = map[key];
      return path ? readPath(data, path) : undefined;
    };

    switch (device.kind) {
      case 'light': {
        const state: { on?: boolean; brightness?: number; colorTemp?: number } = {};
        const on = isOn(pick('on'));
        if (on !== undefined) state.on = on;
        const brightness = num(pick('brightness'));
        if (brightness !== undefined) state.brightness = clamp(brightness, 0, 100);
        const colorTemp = num(pick('colorTemp'));
        if (colorTemp !== undefined) state.colorTemp = colorTemp;
        return { kind: 'light', state };
      }
      case 'climate': {
        const state: {
          mode?: ClimateMode;
          targetTemp?: number;
          currentTemp?: number;
          humidity?: number;
        } = {};
        const mode = pick('mode');
        if (
          mode === 'off' ||
          mode === 'heat' ||
          mode === 'cool' ||
          mode === 'auto' ||
          mode === 'fan_only' ||
          mode === 'dry'
        ) {
          state.mode = mode;
        }
        const target = num(pick('targetTemp'));
        if (target !== undefined) state.targetTemp = target;
        const current = num(pick('currentTemp'));
        if (current !== undefined) state.currentTemp = current;
        const humidity = num(pick('humidity'));
        if (humidity !== undefined) state.humidity = humidity;
        return { kind: 'climate', state };
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
        const on = isOn(pick('on'));
        if (on !== undefined) state.on = on;
        const watts = num(pick('watts'));
        if (watts !== undefined) state.watts = watts;
        const voltage = num(pick('voltage'));
        if (voltage !== undefined) state.voltage = voltage;
        const current = num(pick('current'));
        if (current !== undefined) state.current = current;
        const today = num(pick('energyTodayKwh'));
        if (today !== undefined) state.energyTodayKwh = today;
        const total = num(pick('energyTotalKwh'));
        if (total !== undefined) state.energyTotalKwh = total;
        return { kind: 'power', state };
      }
      case 'sensor': {
        const raw = pick('value');
        if (typeof raw === 'boolean') return { kind: 'sensor', state: { value: raw } };
        const value = num(raw);
        return value === undefined ? null : { kind: 'sensor', state: { value } };
      }
      case 'media': {
        const state: { volume?: number; muted?: boolean; nowPlaying?: string | null } = {};
        const volume = num(pick('volume'));
        if (volume !== undefined) state.volume = clamp(volume, 0, 100);
        const muted = isOn(pick('muted'));
        if (muted !== undefined) state.muted = muted;
        const title = pick('nowPlaying');
        if (typeof title === 'string') state.nowPlaying = title;
        return { kind: 'media', state };
      }
    }
  },
  encode(device, action) {
    const map = device.fieldMap ?? {};
    const key = (field: string, fallback: string) => map[`cmd.${field}`] ?? fallback;
    switch (action.type) {
      case 'power':
        return jsonCommand(device, { [key('power', 'on')]: action.on });
      case 'brightness':
        return jsonCommand(device, {
          [key('power', 'on')]: action.brightness > 0,
          [key('brightness', 'brightness')]: Math.round(action.brightness),
        });
      case 'targetTemp':
        return jsonCommand(device, { [key('targetTemp', 'targetTemp')]: action.targetTemp });
      case 'climateMode':
        return jsonCommand(device, { [key('mode', 'mode')]: action.mode });
      case 'volume':
        return jsonCommand(device, { [key('volume', 'volume')]: Math.round(action.volume) });
      default:
        return null;
    }
  },
};
