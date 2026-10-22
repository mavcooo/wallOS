import { describe, expect, it } from 'vitest';

import { zigbee2mqttAdapter } from '@/mqtt/adapters/zigbee2mqtt';
import { deviceOf } from '@/test/fixtures';
import type { Device } from '@/types/device';

const light = deviceOf('light-living-main', 'light');
const climate = deviceOf('climate-living', 'climate');
const sensor = deviceOf('sensor-living-temp', 'sensor');

/** Stesso hardware del seed, ma con i topic/adapter del firmware in prova. */
function asZigbee<T extends Device>(device: T, state?: object): T {
  return {
    ...device,
    adapter: 'zigbee2mqtt',
    ...(state ? { state: { ...device.state, ...state } } : {}),
  } as T;
}

describe('adapter zigbee2mqtt · decode', () => {
  it('legge on, luminosità (0-254 → %) e temperatura colore in mired', () => {
    const decoded = zigbee2mqttAdapter.decode({
      device: light,
      topic: light.topics.state,
      payload: JSON.stringify({ state: 'ON', brightness: 127, color_temp: 370 }),
    });

    expect(decoded).toEqual({
      kind: 'light',
      state: { on: true, brightness: 50, colorTemp: 2703 },
    });
  });

  it('preferisce color_temp_kelvin al mired quando il firmware manda entrambi', () => {
    const decoded = zigbee2mqttAdapter.decode({
      device: light,
      topic: light.topics.state,
      payload: JSON.stringify({ state: 'OFF', color_temp: 370, color_temp_kelvin: 2700 }),
    });

    expect(decoded).toEqual({ kind: 'light', state: { on: false, colorTemp: 2700 } });
  });

  it('limita la luminosità oltre il fondo scala del firmware', () => {
    const decoded = zigbee2mqttAdapter.decode({
      device: light,
      topic: light.topics.state,
      payload: JSON.stringify({ brightness: 300 }),
    });

    expect(decoded).toEqual({ kind: 'light', state: { brightness: 100 } });
  });

  it('ignora i payload non JSON e quelli dell’availability topic', () => {
    expect(
      zigbee2mqttAdapter.decode({ device: light, topic: light.topics.state, payload: 'ON' }),
    ).toBeNull();

    expect(
      zigbee2mqttAdapter.decode({ device: light, topic: light.topics.state, payload: 'offline' }),
    ).toBeNull();
  });

  it('mappa il clima completo, compresi i numeri inviati come stringa', () => {
    const decoded = zigbee2mqttAdapter.decode({
      device: climate,
      topic: climate.topics.state,
      payload: JSON.stringify({
        system_mode: 'heat',
        occupied_heating_setpoint: '21.5',
        local_temperature: 19.8,
        humidity: 55,
        fan_mode: 'low',
        swing_mode: 'on',
        running_state: 'heat',
      }),
    });

    expect(decoded).toEqual({
      kind: 'climate',
      state: {
        mode: 'heat',
        targetTemp: 21.5,
        currentTemp: 19.8,
        humidity: 55,
        fanSpeed: 'low',
        swing: true,
        action: 'heating',
      },
    });
  });

  it('ignora modalità e ventola fuori vocabolario e limita l’umidità', () => {
    const decoded = zigbee2mqttAdapter.decode({
      device: climate,
      topic: climate.topics.state,
      payload: JSON.stringify({ system_mode: 'turbo', fan_mode: 'max', humidity: 130 }),
    });

    expect(decoded).toEqual({ kind: 'climate', state: { humidity: 100 } });
  });

  it('legge i sensori numerici e quelli booleani (contatto, movimento)', () => {
    expect(
      zigbee2mqttAdapter.decode({
        device: sensor,
        topic: sensor.topics.state,
        payload: JSON.stringify({ temperature: 21.7 }),
      }),
    ).toEqual({ kind: 'sensor', state: { value: 21.7 } });

    const contact = asZigbee(sensor, { type: 'contact' });
    expect(
      zigbee2mqttAdapter.decode({
        device: contact,
        topic: contact.topics.state,
        payload: JSON.stringify({ contact: false }),
      }),
    ).toEqual({ kind: 'sensor', state: { value: false } });

    const motion = asZigbee(sensor, { type: 'motion' });
    expect(
      zigbee2mqttAdapter.decode({
        device: motion,
        topic: motion.topics.state,
        payload: JSON.stringify({ occupancy: true }),
      }),
    ).toEqual({ kind: 'sensor', state: { value: true } });

    // Tipo non gestito dal firmware: nessuna patch, nessuna eccezione.
    expect(
      zigbee2mqttAdapter.decode({
        device: asZigbee(sensor, { type: 'smoke' }),
        topic: sensor.topics.state,
        payload: JSON.stringify({ smoke: true }),
      }),
    ).toBeNull();
  });

  it('legge i misuratori di potenza', () => {
    const plug = asZigbee(deviceOf('power-kitchen-dishwasher', 'power'));
    const decoded = zigbee2mqttAdapter.decode({
      device: plug,
      topic: plug.topics.state,
      payload: JSON.stringify({
        state: 'ON',
        power: 12.5,
        voltage: 230,
        current: 0.05,
        energy_today: 0.4,
        energy: 12.3,
      }),
    });

    expect(decoded).toEqual({
      kind: 'power',
      state: {
        on: true,
        watts: 12.5,
        voltage: 230,
        current: 0.05,
        energyTodayKwh: 0.4,
        energyTotalKwh: 12.3,
      },
    });
  });
});

describe('adapter zigbee2mqtt · encode', () => {
  it('pubblica sul topic di comando con QoS 0', () => {
    const command = zigbee2mqttAdapter.encode(light, { type: 'power', on: true });

    expect(command).toEqual({
      topic: light.topics.command,
      payload: JSON.stringify({ state: 'ON' }),
      qos: 0,
    });
  });

  it('traduce la luminosità in scala 0-254 e accende/spegne', () => {
    expect(
      JSON.parse(zigbee2mqttAdapter.encode(light, { type: 'brightness', brightness: 40 })?.payload ?? ''),
    ).toEqual({ state: 'ON', brightness: 102 });

    expect(
      JSON.parse(zigbee2mqttAdapter.encode(light, { type: 'brightness', brightness: 0 })?.payload ?? ''),
    ).toEqual({ state: 'OFF', brightness: 0 });
  });

  it('converte i kelvin in mired per la temperatura colore', () => {
    expect(
      JSON.parse(
        zigbee2mqttAdapter.encode(light, { type: 'colorTemp', kelvin: 3000 })?.payload ?? '',
      ),
    ).toEqual({ color_temp: 333 });
  });

  it('usa i campi Z2M per clima, ventola e oscillazione', () => {
    const payloads = [
      zigbee2mqttAdapter.encode(climate, { type: 'targetTemp', targetTemp: 21.5 }),
      zigbee2mqttAdapter.encode(climate, { type: 'climateMode', mode: 'auto' }),
      zigbee2mqttAdapter.encode(climate, { type: 'fanSpeed', fanSpeed: 'high' }),
      zigbee2mqttAdapter.encode(climate, { type: 'swing', swing: true }),
      zigbee2mqttAdapter.encode(climate, { type: 'swing', swing: false }),
    ].map((command) => JSON.parse(command?.payload ?? ''));

    expect(payloads).toEqual([
      { occupied_heating_setpoint: 21.5 },
      { system_mode: 'auto' },
      { fan_mode: 'high' },
      { swing_mode: 'on' },
      { swing_mode: 'off' },
    ]);
  });

  it('arrotonda volume e sorgente', () => {
    const volume = zigbee2mqttAdapter.encode(light, { type: 'volume', volume: 41.6 });
    const source = zigbee2mqttAdapter.encode(light, { type: 'source', source: 'HDMI 1' });

    expect(JSON.parse(volume?.payload ?? '')).toEqual({ volume: 42 });
    expect(JSON.parse(source?.payload ?? '')).toEqual({ source: 'HDMI 1' });
  });
});
