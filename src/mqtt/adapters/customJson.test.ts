import { describe, expect, it } from 'vitest';

import { customJsonAdapter } from '@/mqtt/adapters/customJson';
import { deviceOf } from '@/test/fixtures';
import type { Device } from '@/types/device';

const gate = deviceOf('power-outdoor-gate', 'power');
const climate = deviceOf('climate-bedroom', 'climate');
const air = deviceOf('sensor-study-co2', 'sensor');
const tv = deviceOf('media-living-tv', 'media');

const light = {
  ...deviceOf('light-living-main', 'light'),
  adapter: 'custom-json',
  fieldMap: {
    on: 'relay.on',
    brightness: 'dim.level',
    colorTemp: 'dim.kelvin',
    'cmd.power': 'relay',
    'cmd.brightness': 'level',
  },
} satisfies Device;

describe('adapter custom-json · decode', () => {
  it('legge i path annidati della presa e i meter', () => {
    const decoded = customJsonAdapter.decode({
      device: gate,
      topic: gate.topics.state,
      payload:
        '{"relay":{"closed":true},"meter":{"power":2,"volt":230,"amp":0.01,"kwh":4.6}}',
    });

    expect(decoded).toEqual({
      kind: 'power',
      state: { on: true, watts: 2, voltage: 230, current: 0.01, energyTotalKwh: 4.6 },
    });
  });

  it('interpreta i dialetti on/off e non inventa campi mancanti', () => {
    expect(
      customJsonAdapter.decode({
        device: gate,
        topic: gate.topics.state,
        payload: '{"relay":{"closed":"0"}}',
      }),
    ).toEqual({ kind: 'power', state: { on: false } });

    expect(
      customJsonAdapter.decode({
        device: gate,
        topic: gate.topics.state,
        payload: '{"meter":{"power":3}}',
      }),
    ).toEqual({ kind: 'power', state: { watts: 3 } });
  });

  it('legge il clima annidato e scarta le modalità fuori vocabolario', () => {
    expect(
      customJsonAdapter.decode({
        device: climate,
        topic: climate.topics.state,
        payload: '{"hvac":{"mode":"heat","setpoint":21.5,"temp":19.8,"rh":55}}',
      }),
    ).toEqual({
      kind: 'climate',
      state: { mode: 'heat', targetTemp: 21.5, currentTemp: 19.8, humidity: 55 },
    });

    expect(
      customJsonAdapter.decode({
        device: climate,
        topic: climate.topics.state,
        payload: '{"hvac":{"mode":"turbo"}}',
      }),
    ).toEqual({ kind: 'climate', state: {} });
  });

  it('legge sensori numerici e booleani dal campo configurato', () => {
    expect(
      customJsonAdapter.decode({
        device: air,
        topic: air.topics.state,
        payload: '{"env":{"co2":684}}',
      }),
    ).toEqual({ kind: 'sensor', state: { value: 684 } });

    const contact = {
      ...air,
      fieldMap: { value: 'env.occupied' },
      state: { ...air.state, type: 'motion' as const },
    };
    expect(
      customJsonAdapter.decode({
        device: contact,
        topic: contact.topics.state,
        payload: '{"env":{"occupied":true}}',
      }),
    ).toEqual({ kind: 'sensor', state: { value: true } });

    expect(
      customJsonAdapter.decode({
        device: air,
        topic: air.topics.state,
        payload: '{"env":{"other":1}}',
      }),
    ).toBeNull();
  });

  it('legge la luce con luminosità limitata e temperatura colore', () => {
    expect(
      customJsonAdapter.decode({
        device: light,
        topic: light.topics.state,
        payload: '{"relay":{"on":true},"dim":{"level":140,"kelvin":3000}}',
      }),
    ).toEqual({ kind: 'light', state: { on: true, brightness: 100, colorTemp: 3000 } });
  });

  it('legge volume, mute e titolo del media bridge', () => {
    expect(
      customJsonAdapter.decode({
        device: tv,
        topic: tv.topics.state,
        payload:
          '{"player":{"volume":32,"mute":false,"title":"Radio Swiss Jazz","power":true,"input":"HDMI 1"}}',
      }),
    ).toEqual({
      kind: 'media',
      state: { volume: 32, muted: false, nowPlaying: 'Radio Swiss Jazz' },
    });
  });

  it('ignora JSON malformati e scalari', () => {
    for (const payload of ['', '{"relay":', '42', 'null']) {
      expect(customJsonAdapter.decode({ device: gate, topic: gate.topics.state, payload })).toBeNull();
    }
  });

  it('su un array non produce patch (ma nemmeno un crash)', () => {
    expect(
      customJsonAdapter.decode({
        device: gate,
        topic: gate.topics.state,
        payload: '[]',
      }),
    ).toEqual({ kind: 'power', state: {} });
  });
});

describe('adapter custom-json · encode', () => {
  it('rinomina i campi di comando con il prefisso cmd.*', () => {
    expect(customJsonAdapter.encode(gate, { type: 'power', on: true })).toEqual({
      topic: gate.topics.command,
      payload: JSON.stringify({ close: true }),
      qos: 0,
    });

    expect(
      JSON.parse(customJsonAdapter.encode(light, { type: 'brightness', brightness: 40 })?.payload ?? ''),
    ).toEqual({ relay: true, level: 40 });
  });

  it('usa i default quando cmd.* non è configurato', () => {
    expect(
      JSON.parse(customJsonAdapter.encode(climate, { type: 'targetTemp', targetTemp: 21 })?.payload ?? ''),
    ).toEqual({ setpoint: 21 });

    expect(
      JSON.parse(customJsonAdapter.encode(climate, { type: 'climateMode', mode: 'cool' })?.payload ?? ''),
    ).toEqual({ mode: 'cool' });

    expect(
      JSON.parse(customJsonAdapter.encode(tv, { type: 'volume', volume: 41.6 })?.payload ?? ''),
    ).toEqual({ volume: 42 });
  });

  it('restituisce null per azioni non mappabili', () => {
    expect(customJsonAdapter.encode(light, { type: 'colorTemp', kelvin: 3000 })).toBeNull();
    expect(customJsonAdapter.encode(climate, { type: 'fanSpeed', fanSpeed: 'high' })).toBeNull();
    expect(customJsonAdapter.encode(tv, { type: 'source', source: 'HDMI 2' })).toBeNull();
  });
});
