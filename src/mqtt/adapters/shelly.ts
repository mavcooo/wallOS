import type { Device } from '@/types/device';
import { clamp, isOn, num, parseJson } from './types';
import type { DeviceAdapter, DecodeContext } from './types';

/** Shelly Gen2: i comandi viaggiano sul topic RPC con envelope JSON. */
function rpc(device: Device, method: string, params: Record<string, unknown>) {
  return {
    topic: device.topics.command ?? '',
    payload: JSON.stringify({ id: Date.now() % 100000, src: 'domus-kiosk', method, params }),
    qos: 0 as const,
  };
}

function channel(device: Device): number {
  const raw = device.fieldMap?.['channel'];
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export const shellyAdapter: DeviceAdapter = {
  label: 'Shelly Gen2',
  decode({ device, payload }: DecodeContext) {
    const data = parseJson(payload);
    if (!data) return null;

    switch (device.kind) {
      case 'light': {
        const state: { on?: boolean; brightness?: number } = {};
        const on = isOn(data['output']);
        if (on !== undefined) state.on = on;
        const brightness = num(data['brightness']);
        if (brightness !== undefined) state.brightness = clamp(brightness, 0, 100);
        return { kind: 'light', state };
      }
      case 'power': {
        const state: {
          on?: boolean;
          watts?: number;
          voltage?: number;
          current?: number;
          energyTotalKwh?: number;
        } = {};
        const on = isOn(data['output']);
        if (on !== undefined) state.on = on;
        const watts = num(data['apower']);
        if (watts !== undefined) state.watts = watts;
        const voltage = num(data['voltage']);
        if (voltage !== undefined) state.voltage = voltage;
        const current = num(data['current']);
        if (current !== undefined) state.current = current;
        const energy = data['aenergy'];
        if (typeof energy === 'object' && energy !== null) {
          const total = num((energy as Record<string, unknown>)['total']);
          if (total !== undefined) state.energyTotalKwh = Number((total / 1000).toFixed(3));
        }
        return { kind: 'power', state };
      }
      case 'climate': {
        const state: { currentTemp?: number; humidity?: number } = {};
        const temp = num(data['tC']);
        if (temp !== undefined) state.currentTemp = temp;
        const humidity = num(data['humidity']);
        if (humidity !== undefined) state.humidity = clamp(humidity, 0, 100);
        return { kind: 'climate', state };
      }
      case 'sensor': {
        if (device.state.type === 'temperature') {
          const temp = num(data['tC']);
          return temp === undefined ? null : { kind: 'sensor', state: { value: temp } };
        }
        if (device.state.type === 'humidity') {
          const humidity = num(data['humidity']);
          return humidity === undefined ? null : { kind: 'sensor', state: { value: humidity } };
        }
        if (device.state.type === 'contact') {
          const open = isOn(data['window']);
          return open === undefined ? null : { kind: 'sensor', state: { value: open } };
        }
        if (device.state.type === 'motion') {
          const motion = isOn(data['motion']);
          return motion === undefined ? null : { kind: 'sensor', state: { value: motion } };
        }
        return null;
      }
      case 'media':
        return null;
    }
  },
  encode(device, action) {
    const id = channel(device);
    switch (action.type) {
      case 'power':
        return rpc(device, device.kind === 'light' ? 'Light.Set' : 'Switch.Set', {
          id,
          on: action.on,
        });
      case 'brightness':
        return rpc(device, 'Light.Set', {
          id,
          on: action.brightness > 0,
          brightness: Math.round(clamp(action.brightness, 0, 100)),
        });
      case 'targetTemp':
        return rpc(device, 'Thermostat.SetConfig', { id, config: { target_C: action.targetTemp } });
      default:
        return null;
    }
  },
};
