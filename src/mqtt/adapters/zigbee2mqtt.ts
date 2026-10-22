import type { ClimateMode, FanSpeed } from '@/types/device';
import { clamp, isOn, jsonCommand, num, parseJson } from './types';
import type { DeviceAdapter } from './types';

const MODES: readonly ClimateMode[] = ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry'];
const FAN_SPEEDS: readonly FanSpeed[] = ['auto', 'low', 'medium', 'high'];

function toMode(value: unknown): ClimateMode | undefined {
  return MODES.find((mode) => mode === value);
}

function toFanSpeed(value: unknown): FanSpeed | undefined {
  return FAN_SPEEDS.find((speed) => speed === value);
}

/** Zigbee2MQTT pubblica la luminosità 0-254 sul topic `/set` e sullo stato. */
function brightnessToPercent(raw: unknown): number | undefined {
  const value = num(raw);
  return value === undefined ? undefined : clamp(Math.round((value / 254) * 100), 0, 100);
}

function percentToRaw(percent: number): number {
  return Math.round(clamp(percent, 0, 100) * 2.54);
}

export const zigbee2mqttAdapter: DeviceAdapter = {
  label: 'Zigbee2MQTT',
  decode({ device, payload }) {
    if (device.topics.availability && payload.trim() === 'offline') return null;
    const data = parseJson(payload);
    if (!data) return null;

    switch (device.kind) {
      case 'light': {
        const state: { on?: boolean; brightness?: number; colorTemp?: number } = {};
        const on = isOn(data['state']);
        if (on !== undefined) state.on = on;
        const brightness = brightnessToPercent(data['brightness']);
        if (brightness !== undefined) state.brightness = brightness;
        const mired = num(data['color_temp']);
        if (mired !== undefined && mired > 0) {
          state.colorTemp = Math.round(1_000_000 / mired);
        }
        const kelvin = num(data['color_temp_kelvin']);
        if (kelvin !== undefined) state.colorTemp = Math.round(kelvin);
        return { kind: 'light', state };
      }
      case 'climate': {
        const state: {
          mode?: ClimateMode;
          targetTemp?: number;
          currentTemp?: number;
          humidity?: number;
          fanSpeed?: FanSpeed;
          swing?: boolean;
          action?: 'idle' | 'heating' | 'cooling' | 'drying' | 'fan';
        } = {};
        const mode = toMode(data['system_mode']);
        if (mode) state.mode = mode;
        const target = num(data['occupied_heating_setpoint'] ?? data['current_heating_setpoint']);
        if (target !== undefined) state.targetTemp = target;
        const current = num(data['local_temperature']);
        if (current !== undefined) state.currentTemp = current;
        const humidity = num(data['humidity']);
        if (humidity !== undefined) state.humidity = clamp(humidity, 0, 100);
        const fan = toFanSpeed(data['fan_mode']);
        if (fan) state.fanSpeed = fan;
        const swing = isOn(data['swing_mode']);
        if (swing !== undefined) state.swing = swing;
        const running = data['running_state'];
        if (running === 'heat') state.action = 'heating';
        else if (running === 'cool') state.action = 'cooling';
        else if (running === 'fan_only') state.action = 'fan';
        else if (running === 'idle') state.action = 'idle';
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
        const on = isOn(data['state']);
        if (on !== undefined) state.on = on;
        const watts = num(data['power']);
        if (watts !== undefined) state.watts = watts;
        const voltage = num(data['voltage']);
        if (voltage !== undefined) state.voltage = voltage;
        const current = num(data['current']);
        if (current !== undefined) state.current = current;
        const today = num(data['energy_today']);
        if (today !== undefined) state.energyTodayKwh = today;
        const total = num(data['energy']);
        if (total !== undefined) state.energyTotalKwh = total;
        return { kind: 'power', state };
      }
      case 'sensor': {
        const map: Record<string, number | undefined> = {
          temperature: num(data['temperature']),
          humidity: num(data['humidity']),
          co2: num(data['co2']),
          illuminance: num(data['illuminance']),
        };
        if (device.state.type === 'contact' || device.state.type === 'motion') {
          const raw = data[device.state.type === 'contact' ? 'contact' : 'occupancy'];
          const value = isOn(raw);
          return value === undefined ? null : { kind: 'sensor', state: { value } };
        }
        const value = map[device.state.type];
        return value === undefined ? null : { kind: 'sensor', state: { value } };
      }
      case 'media': {
        const state: { volume?: number } = {};
        const volume = num(data['volume']);
        if (volume !== undefined) state.volume = clamp(volume, 0, 100);
        return { kind: 'media', state };
      }
    }
  },
  encode(device, action) {
    switch (action.type) {
      case 'power':
        return jsonCommand(device, { state: action.on ? 'ON' : 'OFF' });
      case 'brightness':
        return jsonCommand(device, {
          state: action.brightness > 0 ? 'ON' : 'OFF',
          brightness: percentToRaw(action.brightness),
        });
      case 'colorTemp':
        return jsonCommand(device, { color_temp: Math.round(1_000_000 / action.kelvin) });
      case 'targetTemp':
        return jsonCommand(device, { occupied_heating_setpoint: action.targetTemp });
      case 'climateMode':
        return jsonCommand(device, { system_mode: action.mode });
      case 'fanSpeed':
        return jsonCommand(device, { fan_mode: action.fanSpeed });
      case 'swing':
        return jsonCommand(device, { swing_mode: action.swing ? 'on' : 'off' });
      case 'volume':
        return jsonCommand(device, { volume: Math.round(action.volume) });
      case 'source':
        return jsonCommand(device, { source: action.source });
    }
  },
};
