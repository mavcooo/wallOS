import { describe, expect, it } from 'vitest';

import { shellyAdapter } from '@/mqtt/adapters/shelly';
import { SHELLY_PAYLOADS } from '@/test/fixtures/mqtt';
import { deviceOf } from '@/test/fixtures';
import type { Device } from '@/types/device';

const plug = deviceOf('power-kitchen-dishwasher', 'power');
const light = deviceOf('light-outdoor', 'light');

function withChannel<T extends Device>(device: T, channel: string): T {
  return { ...device, fieldMap: { ...device.fieldMap, channel } };
}

describe('adapter shelly · decode Gen2', () => {
  it('legge relay RPC (output) e telemetria energetica', () => {
    const decoded = shellyAdapter.decode({
      device: plug,
      topic: plug.topics.state,
      payload: SHELLY_PAYLOADS.switchOn,
    });

    expect(decoded).toEqual({
      kind: 'power',
      state: {
        on: true,
        watts: 1180,
        voltage: 231,
        current: 5.1,
        // aenergy.total è in Wh: 843700 Wh → 843.7 kWh.
        energyTotalKwh: 843.7,
      },
    });
  });

  it('arrotonda i kWh a tre decimali', () => {
    const decoded = shellyAdapter.decode({
      device: plug,
      topic: plug.topics.state,
      payload: '{"output":true,"aenergy":{"total":1234567}}',
    });

    expect(decoded).toEqual({ kind: 'power', state: { on: true, energyTotalKwh: 1234.567 } });
  });

  it('accetta la telemetria senza campi opzionali e output spento', () => {
    expect(
      shellyAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: SHELLY_PAYLOADS.minimalPower,
      }),
    ).toEqual({ kind: 'power', state: { on: true } });

    expect(
      shellyAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: SHELLY_PAYLOADS.switchOff,
      }),
    ).toEqual({
      kind: 'power',
      state: { on: false, watts: 0, voltage: 230, current: 0 },
    });
  });

  it('legge la luce dimmerabile Gen2 e limita la luminosità', () => {
    expect(
      shellyAdapter.decode({
        device: light,
        topic: light.topics.state,
        payload: SHELLY_PAYLOADS.lightOn,
      }),
    ).toEqual({ kind: 'light', state: { on: true, brightness: 72 } });

    expect(
      shellyAdapter.decode({
        device: light,
        topic: light.topics.state,
        payload: '{"output":true,"brightness":130}',
      }),
    ).toEqual({ kind: 'light', state: { on: true, brightness: 100 } });
  });

  it('ignora payload vuoti, non JSON e array', () => {
    for (const payload of [SHELLY_PAYLOADS.empty, SHELLY_PAYLOADS.invalidJson, '[]', 'null']) {
      expect(shellyAdapter.decode({ device: plug, topic: plug.topics.state, payload })).toBeNull();
    }
  });

  it('non interpreta il dialetto Gen1 (ison/power): nessuna patch, nessun crash', () => {
    // Gen1 non è supportato dal progetto (vedi README, tabella adapter): il
    // payload arriva, viene parsato, ma non produce campi normalizzati.
    const decoded = shellyAdapter.decode({
      device: plug,
      topic: plug.topics.state,
      payload: SHELLY_PAYLOADS.gen1Relay,
    });

    // `voltage` è l'unico campo che coincide per nome: on/watts non arrivano.
    expect(decoded).toEqual({ kind: 'power', state: { voltage: 230 } });
  });

  it('ignora le risposte RPC senza campi di stato', () => {
    expect(
      shellyAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: SHELLY_PAYLOADS.rpcResult,
      }),
    ).toEqual({ kind: 'power', state: {} });
  });

  it('legge temperatura e umidità del termostato Shelly', () => {
    const climate = deviceOf('climate-living', 'climate');

    expect(
      shellyAdapter.decode({
        device: climate,
        topic: climate.topics.state,
        payload: '{"tC":21.4,"humidity":48}',
      }),
    ).toEqual({ kind: 'climate', state: { currentTemp: 21.4, humidity: 48 } });

    expect(
      shellyAdapter.decode({
        device: climate,
        topic: climate.topics.state,
        payload: '{"humidity":130}',
      }),
    ).toEqual({ kind: 'climate', state: { humidity: 100 } });

    // Telemetria del termostato senza campi utili: patch vuota, nessun crash.
    expect(
      shellyAdapter.decode({ device: climate, topic: climate.topics.state, payload: '{}' }),
    ).toEqual({ kind: 'climate', state: {} });
  });

  it('legge i sensori Shelly per tipo di metrica', () => {
    const withType = (type: 'temperature' | 'humidity' | 'contact' | 'motion' | 'co2') => ({
      ...deviceOf('sensor-living-temp', 'sensor'),
      state: { ...deviceOf('sensor-living-temp', 'sensor').state, type },
    });

    const cases = [
      { type: 'temperature' as const, payload: '{"tC":21.4}', expected: 21.4 },
      { type: 'humidity' as const, payload: '{"humidity":48}', expected: 48 },
      { type: 'contact' as const, payload: '{"window":true}', expected: true },
      { type: 'motion' as const, payload: '{"motion":false}', expected: false },
    ];

    for (const { type, payload, expected } of cases) {
      const device = withType(type);
      expect(
        shellyAdapter.decode({ device, topic: device.topics.state, payload }),
      ).toEqual({ kind: 'sensor', state: { value: expected } });
    }

    // Tipo non gestito dal firmware: nessuna patch, nessuna eccezione.
    const co2 = withType('co2');
    expect(shellyAdapter.decode({ device: co2, topic: co2.topics.state, payload: '{}' })).toBeNull();

    // Campo assente per il tipo dichiarato: nessuna patch.
    const temp = withType('temperature');
    expect(
      shellyAdapter.decode({ device: temp, topic: temp.topics.state, payload: '{"humidity":48}' }),
    ).toBeNull();
  });

  it('non gestisce i media e ignora aenergy non numerico', () => {
    const media = deviceOf('media-living-tv', 'media');
    expect(shellyAdapter.decode({ device: media, topic: media.topics.state, payload: '{}' })).toBeNull();

    expect(
      shellyAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: '{"output":true,"aenergy":"n/d"}',
      }),
    ).toEqual({ kind: 'power', state: { on: true } });

    expect(
      shellyAdapter.decode({
        device: plug,
        topic: plug.topics.state,
        payload: '{"output":true,"aenergy":{"total":"n/d"}}',
      }),
    ).toEqual({ kind: 'power', state: { on: true } });
  });
});

describe('adapter shelly · encode', () => {
  function paramsOf(command: { payload: string } | null): Record<string, unknown> {
    const envelope = JSON.parse(command?.payload ?? '{}') as {
      src?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    return { src: envelope.src, method: envelope.method, ...envelope.params };
  }

  it('invia Switch.Set per una presa, sul canale dichiarato in fieldMap', () => {
    const command = shellyAdapter.encode(withChannel(plug, '2'), { type: 'power', on: false });

    expect(command?.topic).toBe(plug.topics.command);
    expect(command?.qos).toBe(0);
    expect(paramsOf(command)).toMatchObject({
      id: 2,
      on: false,
      src: 'domus-kiosk',
      method: 'Switch.Set',
    });
  });

  it('usa Light.Set per una luce e spegne con luminosità zero', () => {
    const on = shellyAdapter.encode(light, { type: 'brightness', brightness: 40 });
    const off = shellyAdapter.encode(light, { type: 'brightness', brightness: 0 });

    expect(paramsOf(on)).toMatchObject({ method: 'Light.Set', id: 0, on: true, brightness: 40 });
    expect(paramsOf(off)).toMatchObject({ method: 'Light.Set', on: false, brightness: 0 });
  });

  it('arrotonda e limita la luminosità a 0-100', () => {
    expect(
      paramsOf(shellyAdapter.encode(light, { type: 'brightness', brightness: 140 })),
    ).toMatchObject({ brightness: 100 });
  });

  it('configura il setpoint del termostato', () => {
    const climate = deviceOf('climate-living', 'climate');
    const command = shellyAdapter.encode(climate, { type: 'targetTemp', targetTemp: 21.5 });

    expect(paramsOf(command)).toMatchObject({
      method: 'Thermostat.SetConfig',
      config: { target_C: 21.5 },
    });
  });

  it('restituisce null per le azioni che il firmware non supporta', () => {
    expect(shellyAdapter.encode(light, { type: 'volume', volume: 30 })).toBeNull();
    expect(shellyAdapter.encode(light, { type: 'colorTemp', kelvin: 3000 })).toBeNull();
  });
});
