import { describe, expect, it } from 'vitest';

import { normalizeDiscovery, parseDiscoveryTopic } from '@/mqtt/discovery/normalize';
import type { HaDiscoveryConfig } from '@/mqtt/discovery/types';
import { parseDiscoveryPayload } from '@/mqtt/discovery/types';

const PREFIXES = ['homeassistant'] as const;

function refFor(topic: string) {
  const ref = parseDiscoveryTopic(topic, PREFIXES);
  if (!ref) throw new Error(`topic di discovery non valido: ${topic}`);
  return ref;
}

/** Passa dal parser reale: così ogni caso copre anche l'espansione delle abbreviazioni. */
function normalize(topic: string, config: HaDiscoveryConfig | Record<string, unknown>) {
  const parsed = parseDiscoveryPayload(JSON.stringify(config));
  if (!parsed) throw new Error('payload di discovery non valido');
  return normalizeDiscovery(refFor(topic), parsed);
}

const LIGHT: HaDiscoveryConfig = {
  name: 'Pianta',
  uniq_id: '0xabc_light',
  stat_t: 'zigbee2mqtt/pianta/state',
  cmd_t: 'zigbee2mqtt/pianta/set',
  bri_stat_t: 'zigbee2mqtt/pianta/brightness',
  bri_cmd_t: 'zigbee2mqtt/pianta/set/brightness',
  bri_scl: 255,
  clr_temp_stat_t: 'zigbee2mqtt/pianta/color_temp',
  clr_temp_cmd_t: 'zigbee2mqtt/pianta/set/color_temp',
  min_mirs: 153,
  max_mirs: 500,
  dev: {
    identifiers: ['0xabc'],
    name: 'Pianta',
    manufacturer: 'Philips',
    model: 'Hue White',
    suggested_area: 'Soggiorno',
  },
};

describe('parseDiscoveryTopic', () => {
  it('riconosce la forma standard e quella con node_id', () => {
    expect(parseDiscoveryTopic('homeassistant/light/pianta/config', PREFIXES)).toMatchObject({
      prefix: 'homeassistant',
      component: 'light',
      objectId: 'pianta',
      entityId: 'ha:light:pianta',
    });

    expect(
      parseDiscoveryTopic('homeassistant/sensor/0xabc/temp/config', PREFIXES),
    ).toMatchObject({
      component: 'sensor',
      nodeId: '0xabc',
      objectId: 'temp',
      entityId: 'ha:sensor:0xabc:temp',
    });
  });

  it('rifiuta altri topic e prefissi non configurati', () => {
    expect(parseDiscoveryTopic('homeassistant/light/pianta/state', PREFIXES)).toBeNull();
    expect(parseDiscoveryTopic('altro/light/pianta/config', PREFIXES)).toBeNull();
    expect(parseDiscoveryTopic('homeassistant/light/config', PREFIXES)).toBeNull();
  });
});

describe('normalizeDiscovery · light', () => {
  it('espande le abbreviazioni e mappa stato, dimmer e temperatura colore', () => {
    const result = normalize('homeassistant/light/pianta/config', LIGHT);
    if (!result || result.device.kind !== 'light') throw new Error('atteso un light');

    const { device } = result;
    expect(device.id).toBe('ha:light:pianta');
    expect(device.name).toBe('Pianta');
    expect(device.adapter).toBe('ha-discovery');
    expect(device.model).toBe('Philips Hue White');
    expect(device.room).toBe('soggiorno');
    expect(device.discovery).toMatchObject({
      entityId: 'ha:light:pianta',
      uniqueId: '0xabc_light',
      component: 'light',
      area: 'Soggiorno',
      configTopic: 'homeassistant/light/pianta/config',
    });
    expect(device.discovery?.state.map((channel) => channel.field)).toEqual([
      'on',
      'brightness',
      'colorTemp',
    ]);
    expect(device.discovery?.state[1]).toMatchObject({ kind: 'brightness', scale: 255 });
    expect(device.discovery?.commands.map((command) => command.field)).toEqual([
      'on',
      'brightness',
      'colorTemp',
    ]);
    expect(device.state).toMatchObject({ on: false, brightness: 0 });
    expect(device.capabilities).toEqual({ dimmable: true, colorTempRange: [2000, 6536] });
  });

  it('senza canali di luminosità non è dimmable', () => {
    const result = normalize('homeassistant/light/semplice/config', {
      stat_t: 'casa/luce/state',
      cmd_t: 'casa/luce/set',
    });
    if (!result || result.device.kind !== 'light') throw new Error('atteso un light');

    expect(result.device.capabilities).toEqual({ dimmable: false });
    expect(result.device.discovery?.state).toHaveLength(1);
  });

  it('senza suggested_area finisce in “Non assegnati”', () => {
    const result = normalize('homeassistant/light/garage/config', {
      stat_t: 'casa/garage/state',
    });

    expect(result?.device.room).toBe('unassigned');
  });

  it('ignora componenti non supportati o annunci senza topic', () => {
    expect(normalize('homeassistant/cover/tapparella/config', { cmd_t: 'casa/tapparella/set' })).toBeNull();
    expect(normalize('homeassistant/light/vuoto/config', { name: 'Vuota' })).toBeNull();
  });
});

describe('normalizeDiscovery · switch, binary_sensor, sensor, climate', () => {
  it('mappa uno switch su un device power con i payload custom', () => {
    const result = normalize('homeassistant/switch/presa/config', {
      name: 'Presa studio',
      stat_t: 'casa/presa/state',
      cmd_t: 'casa/presa/set',
      pl_on: '1',
      pl_off: '0',
      dev: { name: 'Presa', suggested_area: 'Studio' },
    });
    if (!result || result.device.kind !== 'power') throw new Error('atteso un power');

    expect(result.device.room).toBe('studio');
    expect(result.device.state.on).toBe(false);
    expect(result.device.discovery?.state[0]).toMatchObject({
      kind: 'boolean',
      payloadOn: '1',
      payloadOff: '0',
    });
    expect(result.device.discovery?.commands[0]).toMatchObject({ field: 'on', kind: 'raw' });
  });

  it('deduce il tipo dei binary_sensor dal device_class', () => {
    const typeOf = (deviceClass: string) =>
      normalize(`homeassistant/binary_sensor/${deviceClass}/config`, {
        stat_t: `casa/${deviceClass}`,
        dev_cla: deviceClass,
      });

    const smoke = typeOf('smoke');
    const door = typeOf('door');
    const motion = typeOf('occupancy');

    expect(smoke?.device.kind === 'sensor' && smoke.device.state.type).toBe('smoke');
    expect(door?.device.kind === 'sensor' && door.device.state.type).toBe('contact');
    expect(motion?.device.kind === 'sensor' && motion.device.state.type).toBe('motion');
  });

  it('mappa unità e device_class dei sensori, con il template di valore', () => {
    const temperature = normalize('homeassistant/sensor/temp/config', {
      name: 'Temperatura',
      stat_t: 'casa/temp',
      dev_cla: 'temperature',
      unit_of_meas: '°C',
      val_tpl: '{{ value_json.temperature }}',
    });
    if (!temperature || temperature.device.kind !== 'sensor') throw new Error('atteso un sensor');

    expect(temperature.device.state).toMatchObject({ type: 'temperature', unit: '°C' });
    expect(temperature.device.discovery?.state[0]).toMatchObject({
      kind: 'number',
      template: '{{ value_json.temperature }}',
    });

    const energy = normalize('homeassistant/sensor/kwh/config', {
      stat_t: 'casa/kwh',
      dev_cla: 'energy',
      unit_of_meas: 'kWh',
    });
    expect(energy?.device.kind === 'sensor' && energy.device.state.type).toBe('energy');

    // Nessun device_class e unità sconosciuta: entità ignorata.
    expect(
      normalize('homeassistant/sensor/strano/config', {
        stat_t: 'casa/strano',
        unit_of_meas: 'banane',
      }),
    ).toBeNull();
  });

  it('mappa il clima con setpoint, temperatura corrente e modalità', () => {
    const result = normalize('homeassistant/climate/termo/config', {
      name: 'Termostato',
      curr_temp_t: 'casa/termo/current',
      temp_stat_t: 'casa/termo/target',
      temp_cmd_t: 'casa/termo/set/target',
      mode_stat_t: 'casa/termo/mode',
      mode_cmd_t: 'casa/termo/set/mode',
      min_temp: 5,
      max_temp: 30,
      temp_step: 0.5,
      dev: { suggested_area: 'Bagno' },
    });
    if (!result || result.device.kind !== 'climate') throw new Error('atteso un climate');

    expect(result.device.room).toBe('bagno');
    expect(result.device.minTemp).toBe(5);
    expect(result.device.maxTemp).toBe(30);
    expect(result.device.tempStep).toBe(0.5);
    expect(result.device.discovery?.state.map((channel) => channel.field)).toEqual([
      'currentTemp',
      'targetTemp',
      'mode',
    ]);
    expect(result.device.discovery?.state[2]?.kind).toBe('text');
  });
});

describe('parseDiscoveryPayload', () => {
  it('espande le abbreviazioni anche dentro availability', () => {
    const config = parseDiscoveryPayload(
      JSON.stringify({
        stat_t: 'casa/stato',
        avty: [{ 'topic': 'casa/online', 'pl_avail': 'online', 'pl_not_avail': 'offline' }],
      }),
    );

    expect(config?.state_topic).toBe('casa/stato');
    expect(config?.availability).toEqual([
      { topic: 'casa/online', payload_available: 'online', payload_not_available: 'offline' },
    ]);
  });

  it('non lancia su payload malformati o non oggetto', () => {
    expect(parseDiscoveryPayload('non-json')).toBeNull();
    expect(parseDiscoveryPayload('[1,2,3]')).toBeNull();
    expect(parseDiscoveryPayload('   ')).toBeNull();
  });
});
