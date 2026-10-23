import { describe, expect, it } from 'vitest';

import { haDiscoveryAdapter } from '@/mqtt/adapters/haDiscovery';
import { normalizeDiscovery, parseDiscoveryTopic } from '@/mqtt/discovery/normalize';
import { parseDiscoveryPayload } from '@/mqtt/discovery/types';
import type { Device } from '@/types/device';

/** Costruisce il device come farà il bridge: annuncio → normalizzatore. */
function deviceFrom(topic: string, config: Record<string, unknown>): Device {
  const ref = parseDiscoveryTopic(topic, ['homeassistant']);
  if (!ref) throw new Error(`topic non valido: ${topic}`);
  const parsed = parseDiscoveryPayload(JSON.stringify(config));
  if (!parsed) throw new Error('payload non valido');
  const result = normalizeDiscovery(ref, parsed);
  if (!result) throw new Error('annuncio non normalizzabile');
  return result.device;
}

const light = deviceFrom('homeassistant/light/pianta/config', {
  name: 'Pianta',
  stat_t: 'z2m/pianta/state',
  cmd_t: 'z2m/pianta/set',
  bri_stat_t: 'z2m/pianta/brightness',
  bri_cmd_t: 'z2m/pianta/set/brightness',
  clr_temp_stat_t: 'z2m/pianta/color_temp',
  clr_temp_cmd_t: 'z2m/pianta/set/color_temp',
});

const climate = deviceFrom('homeassistant/climate/termo/config', {
  name: 'Termostato',
  curr_temp_t: 'casa/termo/current',
  temp_stat_t: 'casa/termo/target',
  temp_cmd_t: 'casa/termo/set/target',
  mode_stat_t: 'casa/termo/mode',
  mode_cmd_t: 'casa/termo/set/mode',
});

describe('ha-discovery · decode', () => {
  it('legge on/off dal topic di stato', () => {
    expect(
      haDiscoveryAdapter.decode({ device: light, topic: 'z2m/pianta/state', payload: 'ON' }),
    ).toEqual({ kind: 'light', state: { on: true } });

    expect(
      haDiscoveryAdapter.decode({ device: light, topic: 'z2m/pianta/state', payload: 'off' }),
    ).toEqual({ kind: 'light', state: { on: false } });
  });

  it('converte la luminosità dal fondo scala dichiarato al 0-100 interno', () => {
    expect(
      haDiscoveryAdapter.decode({ device: light, topic: 'z2m/pianta/brightness', payload: '127' }),
    ).toEqual({ kind: 'light', state: { brightness: 50 } });

    expect(
      haDiscoveryAdapter.decode({ device: light, topic: 'z2m/pianta/brightness', payload: '255' }),
    ).toEqual({ kind: 'light', state: { brightness: 100 } });
  });

  it('converte i mired in kelvin', () => {
    expect(
      haDiscoveryAdapter.decode({
        device: light,
        topic: 'z2m/pianta/color_temp',
        payload: '370',
      }),
    ).toEqual({ kind: 'light', state: { colorTemp: 2703 } });
  });

  it('rispetta payload_on/payload_off custom', () => {
    const press = deviceFrom('homeassistant/switch/presa/config', {
      name: 'Presa',
      stat_t: 'casa/presa/state',
      cmd_t: 'casa/presa/set',
      pl_on: '1',
      pl_off: '0',
    });

    expect(
      haDiscoveryAdapter.decode({ device: press, topic: 'casa/presa/state', payload: '1' }),
    ).toEqual({ kind: 'power', state: { on: true } });
    expect(
      haDiscoveryAdapter.decode({ device: press, topic: 'casa/presa/state', payload: '0' }),
    ).toEqual({ kind: 'power', state: { on: false } });
  });

  it('estrae il valore dal value_template e dal payload JSON', () => {
    const sensor = deviceFrom('homeassistant/sensor/temp/config', {
      stat_t: 'casa/temp',
      dev_cla: 'temperature',
      unit_of_meas: '°C',
      val_tpl: '{{ value_json.temperatura.attuale }}',
    });

    expect(
      haDiscoveryAdapter.decode({
        device: sensor,
        topic: 'casa/temp',
        payload: '{"temperatura":{"attuale":21.7}}',
      }),
    ).toEqual({ kind: 'sensor', state: { value: 21.7 } });
  });

  it('legge i binary_sensor come booleani', () => {
    const door = deviceFrom('homeassistant/binary_sensor/porta/config', {
      stat_t: 'casa/porta',
      dev_cla: 'door',
    });

    expect(
      haDiscoveryAdapter.decode({ device: door, topic: 'casa/porta', payload: 'ON' }),
    ).toEqual({ kind: 'sensor', state: { value: true } });
  });

  it('mappa le modalità clima e scarta quelle sconosciute', () => {
    expect(
      haDiscoveryAdapter.decode({ device: climate, topic: 'casa/termo/mode', payload: 'heat' }),
    ).toEqual({ kind: 'climate', state: { mode: 'heat', action: 'idle' } });

    expect(
      haDiscoveryAdapter.decode({ device: climate, topic: 'casa/termo/mode', payload: 'turbo' }),
    ).toBeNull();
  });

  it('legge temperatura corrente e setpoint del clima', () => {
    expect(
      haDiscoveryAdapter.decode({ device: climate, topic: 'casa/termo/current', payload: '19.8' }),
    ).toEqual({ kind: 'climate', state: { currentTemp: 19.8 } });

    expect(
      haDiscoveryAdapter.decode({ device: climate, topic: 'casa/termo/target', payload: '21.5' }),
    ).toEqual({ kind: 'climate', state: { targetTemp: 21.5 } });
  });

  it('porta il clima su off con azione idle', () => {
    expect(
      haDiscoveryAdapter.decode({ device: climate, topic: 'casa/termo/mode', payload: 'off' }),
    ).toEqual({ kind: 'climate', state: { mode: 'off', action: 'idle' } });
  });

  it('converte i sensori numerici e scarta i valori non numerici', () => {
    const plain = deviceFrom('homeassistant/sensor/temp2/config', {
      stat_t: 'casa/temp2',
      dev_cla: 'temperature',
      unit_of_meas: '°C',
    });

    expect(
      haDiscoveryAdapter.decode({ device: plain, topic: 'casa/temp2', payload: '21.7' }),
    ).toEqual({ kind: 'sensor', state: { value: 21.7 } });

    expect(
      haDiscoveryAdapter.decode({ device: plain, topic: 'casa/temp2', payload: 'n/d' }),
    ).toBeNull();
  });

  it('scarta i binary_sensor con payload sconosciuto', () => {
    const door = deviceFrom('homeassistant/binary_sensor/finestra/config', {
      stat_t: 'casa/finestra',
      dev_cla: 'window',
    });

    expect(
      haDiscoveryAdapter.decode({ device: door, topic: 'casa/finestra', payload: 'unknown' }),
    ).toBeNull();
  });

  it('ignora topic non dichiarati nell’annuncio', () => {
    expect(
      haDiscoveryAdapter.decode({ device: light, topic: 'z2m/pianta/sconosciuto', payload: '1' }),
    ).toBeNull();
  });
});

describe('ha-discovery · encode', () => {
  it('pubblica ON/OFF sul command_topic', () => {
    expect(haDiscoveryAdapter.encode(light, { type: 'power', on: true })).toEqual({
      topic: 'z2m/pianta/set',
      payload: 'ON',
      qos: 0,
    });
    expect(haDiscoveryAdapter.encode(light, { type: 'power', on: false })?.payload).toBe('OFF');
  });

  it('converte la luminosità percentuale nella scala del firmware', () => {
    expect(haDiscoveryAdapter.encode(light, { type: 'brightness', brightness: 40 })).toEqual({
      topic: 'z2m/pianta/set/brightness',
      payload: '102',
      qos: 0,
    });
  });

  it('converte i kelvin in mired', () => {
    expect(haDiscoveryAdapter.encode(light, { type: 'colorTemp', kelvin: 3000 })?.payload).toBe(
      '333',
    );
  });

  it('usa i topic di setpoint e modalità del clima', () => {
    expect(haDiscoveryAdapter.encode(climate, { type: 'targetTemp', targetTemp: 21.5 })).toEqual({
      topic: 'casa/termo/set/target',
      payload: '21.5',
      qos: 0,
    });
    expect(
      haDiscoveryAdapter.encode(climate, { type: 'climateMode', mode: 'auto' })?.payload,
    ).toBe('auto');
  });

  it('rifiuta le azioni senza canale (volume, sorgente)', () => {
    expect(haDiscoveryAdapter.encode(light, { type: 'volume', volume: 30 })).toBeNull();
    expect(haDiscoveryAdapter.encode(light, { type: 'source', source: 'HDMI 1' })).toBeNull();
  });
});
