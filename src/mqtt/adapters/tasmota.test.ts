import { describe, expect, it } from 'vitest';

import { tasmotaAdapter } from '@/mqtt/adapters/tasmota';
import { deviceOf } from '@/test/fixtures';
import { TASMOTA_PAYLOADS } from '@/test/fixtures/mqtt';
import type { Device } from '@/types/device';

const plug = deviceOf('power-kitchen-oven', 'power');
const light = deviceOf('light-study', 'light');
const sensor = deviceOf('sensor-living-temp', 'sensor');

/** Stesso hardware del seed, con l'adapter del firmware in prova. */
function asTasmota<T extends Device>(device: T): T {
  return { ...device, adapter: 'tasmota' };
}

describe('adapter tasmota · decode', () => {
  it('legge POWER in chiaro dai topic stat/.../POWER', () => {
    expect(
      tasmotaAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: TASMOTA_PAYLOADS.powerOn,
      }),
    ).toEqual({ kind: 'power', state: { on: true } });

    expect(
      tasmotaAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: TASMOTA_PAYLOADS.powerOff,
      }),
    ).toEqual({ kind: 'power', state: { on: false } });
  });

  it('mantiene la luminosità corrente accendendo una luce e la azzera spegnendola', () => {
    expect(
      tasmotaAdapter.decode({
        device: light,
        topic: light.topics.state,
        payload: TASMOTA_PAYLOADS.powerOn,
      }),
    ).toEqual({ kind: 'light', state: { on: true, brightness: light.state.brightness } });

    expect(
      tasmotaAdapter.decode({
        device: light,
        topic: light.topics.state,
        payload: TASMOTA_PAYLOADS.powerOff,
      }),
    ).toEqual({ kind: 'light', state: { on: false, brightness: 0 } });
  });

  it('legge tele/STATE e stat/RESULT', () => {
    expect(
      tasmotaAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: TASMOTA_PAYLOADS.state,
      }),
    ).toEqual({ kind: 'power', state: { on: true } });

    expect(
      tasmotaAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: TASMOTA_PAYLOADS.result,
      }),
    ).toEqual({ kind: 'power', state: { on: true } });
  });

  it('legge POWER1 quando POWER è assente (canali multipli)', () => {
    expect(
      tasmotaAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: TASMOTA_PAYLOADS.multiPower,
      }),
    ).toEqual({ kind: 'power', state: { on: true } });

    // POWER2 da solo non è mappato sul device a canale singolo: nessun crash.
    expect(
      tasmotaAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: '{"POWER2":"ON"}',
      }),
    ).toEqual({ kind: 'power', state: {} });
  });

  it('normalizza tele/SENSOR con ENERGY (potenza, tensione, corrente, kWh)', () => {
    expect(
      tasmotaAdapter.decode({
        device: plug,
        topic: 'tele/kitchen/oven/SENSOR',
        payload: TASMOTA_PAYLOADS.sensorEnergy,
      }),
    ).toEqual({
      kind: 'power',
      state: {
        watts: 1180,
        voltage: 231,
        current: 5.1,
        energyTodayKwh: 0.36,
        energyTotalKwh: 412.1,
      },
    });
  });

  it('legge Dimmer e CT da stat/RESULT, convertendo i mired in kelvin', () => {
    expect(
      tasmotaAdapter.decode({
        device: light,
        topic: light.topics.state,
        payload: TASMOTA_PAYLOADS.dimmerResult,
      }),
    ).toEqual({ kind: 'light', state: { on: true, brightness: 80, colorTemp: 3333 } });
  });

  it('legge il setpoint del clima e ne deduce l’azione da POWER', () => {
    const climate = asTasmota(deviceOf('climate-living', 'climate'));
    const decoded = tasmotaAdapter.decode({
      device: climate,
      topic: climate.topics.state,
      payload:
        '{"Setpoint":21.5,"Temperature":19.8,"Humidity":55,"Mode":"heat","POWER":"ON"}',
    });

    expect(decoded).toEqual({
      kind: 'climate',
      state: {
        targetTemp: 21.5,
        currentTemp: 19.8,
        humidity: 55,
        mode: 'heat',
        action: 'heating',
      },
    });
  });

  it('legge la temperatura da ANALOG nei sensori', () => {
    const temp = asTasmota(sensor);
    expect(
      tasmotaAdapter.decode({
        device: temp,
        topic: 'tele/living/temp/SENSOR',
        payload: TASMOTA_PAYLOADS.sensorAnalog,
      }),
    ).toEqual({ kind: 'sensor', state: { value: 21.4 } });

    // Sensore senza il campo atteso: nessuna patch.
    expect(
      tasmotaAdapter.decode({
        device: temp,
        topic: 'tele/living/temp/SENSOR',
        payload: '{"Time":"2026-10-23T08:00:00"}',
      }),
    ).toBeNull();
    expect(
      tasmotaAdapter.decode({
        device: temp,
        topic: 'tele/living/temp/SENSOR',
        payload: '{"ANALOG":{"Humidity":50}}',
      }),
    ).toBeNull();

    // Sensore non-temperatura: il fallback legge comunque `Temperature`
    // pubblicata al livello radice del payload.
    const humidity = {
      ...asTasmota(sensor),
      state: { ...sensor.state, type: 'humidity' as const },
    };
    expect(
      tasmotaAdapter.decode({
        device: humidity,
        topic: 'tele/living/temp/SENSOR',
        payload: '{"Temperature":21.4}',
      }),
    ).toEqual({ kind: 'sensor', state: { value: 21.4 } });
  });

  it('è pura e deterministica: non muta il device e ripete lo stesso output', () => {
    const snapshot = structuredClone(light);
    const context = { device: light, topic: light.topics.state, payload: TASMOTA_PAYLOADS.powerOn };

    const first = tasmotaAdapter.decode(context);
    const second = tasmotaAdapter.decode(context);

    expect(first).toEqual(second);
    expect(light).toEqual(snapshot);
  });

  it('non decodifica i media (nessun payload Tasmota previsto)', () => {
    const media = asTasmota(deviceOf('media-living-tv', 'media'));

    expect(
      tasmotaAdapter.decode({ device: media, topic: media.topics.state, payload: '{}' }),
    ).toBeNull();
  });

  it('ignora payload vuoti, malformati e scalari non riconosciuti', () => {
    for (const payload of [TASMOTA_PAYLOADS.empty, TASMOTA_PAYLOADS.invalidJson, '42', '[]']) {
      expect(
        tasmotaAdapter.decode({ device: plug, topic: plug.topics.state, payload }),
      ).toBeNull();
    }
  });
});

describe('adapter tasmota · encode', () => {
  it('pubblica POWER e Dimmer sul topic di comando', () => {
    expect(tasmotaAdapter.encode(plug, { type: 'power', on: true })).toEqual({
      topic: 'cmnd/kitchen/oven/POWER',
      payload: 'ON',
      qos: 0,
    });
    expect(tasmotaAdapter.encode(plug, { type: 'power', on: false })).toEqual({
      topic: 'cmnd/kitchen/oven/POWER',
      payload: 'OFF',
      qos: 0,
    });
    expect(tasmotaAdapter.encode(light, { type: 'brightness', brightness: 55 })).toEqual({
      topic: 'cmnd/study/ceiling/Dimmer',
      payload: '55',
      qos: 0,
    });
  });

  it('limita e arrotonda la luminosità', () => {
    expect(
      tasmotaAdapter.encode(light, { type: 'brightness', brightness: 140 })?.payload,
    ).toBe('100');
    expect(
      tasmotaAdapter.encode(light, { type: 'brightness', brightness: -5 })?.payload,
    ).toBe('0');
    expect(
      tasmotaAdapter.encode(light, { type: 'brightness', brightness: 42.6 })?.payload,
    ).toBe('43');
  });

  it('usa Setpoint e Mode per il clima', () => {
    const climate = asTasmota(deviceOf('climate-living', 'climate'));

    expect(tasmotaAdapter.encode(climate, { type: 'targetTemp', targetTemp: 21.5 })).toEqual({
      topic: `${climate.topics.command}/Setpoint`,
      payload: '21.5',
      qos: 0,
    });
    expect(tasmotaAdapter.encode(climate, { type: 'climateMode', mode: 'dry' })).toEqual({
      topic: `${climate.topics.command}/Mode`,
      payload: 'dry',
      qos: 0,
    });
  });

  it('restituisce null per le azioni non supportate dal firmware', () => {
    expect(tasmotaAdapter.encode(light, { type: 'colorTemp', kelvin: 2700 })).toBeNull();
    expect(tasmotaAdapter.encode(light, { type: 'volume', volume: 20 })).toBeNull();
  });
});
