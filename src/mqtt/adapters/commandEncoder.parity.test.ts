import { describe, expect, it } from 'vitest';

import { initialDevices } from '../../../server/seed-data/devices';
import {
  encodeDeviceAction,
  type CommandTarget,
} from '../../../server/services/commandEncoder';
import { normalizeDiscovery, parseDiscoveryTopic } from '@/mqtt/discovery/normalize';
import { parseDiscoveryPayload } from '@/mqtt/discovery/types';
import type { ControlAction, Device } from '@/types/device';

import { getAdapter } from './index';

/**
 * Parità fra i due codificatori di comandi.
 *
 * Il pannello traduce un'azione in `src/mqtt/adapters/*`, il motore di
 * automazioni in `server/services/commandEncoder.ts`. Devono produrre lo stesso
 * topic e lo stesso payload: altrimenti la stessa luce riceverebbe un dialetto
 * diverso a seconda che il comando arrivi da un dito o da una regola. Questo
 * test confronta caso per caso sulle entità del seed, così un dialetto che
 * cambia da una parte sola non passa inosservato.
 */

// Lo stesso elenco vale per i due lati: `ControlAction` (pannello) è un
// sottoinsieme tipizzato di `DeviceAction` (motore).
const ACTIONS: readonly ControlAction[] = [
  { type: 'power', on: true },
  { type: 'power', on: false },
  { type: 'brightness', brightness: 12 },
  { type: 'brightness', brightness: 0 },
  { type: 'colorTemp', kelvin: 2300 },
  { type: 'targetTemp', targetTemp: 21.5 },
  { type: 'climateMode', mode: 'heat' },
  { type: 'fanSpeed', fanSpeed: 'low' },
  { type: 'swing', swing: true },
  { type: 'volume', volume: 35 },
  { type: 'source', source: 'HDMI 1' },
];

function targetOf(device: Device): CommandTarget {
  return {
    id: device.id,
    adapter: device.adapter,
    kind: device.kind,
    commandTopic: device.topics.command ?? null,
    fieldMap: device.fieldMap ?? null,
    discoveryCommands: device.discovery?.commands ?? null,
  };
}

/**
 * L'envelope RPC Shelly dichiara `src` e un `id` casuale: il resto del payload
 * deve essere identico (il motore si firma `wallos-engine`, il pannello
 * `domus-kiosk`, così il broker può distinguere i due client).
 */
function normalize(command: { topic: string; payload: string }): {
  topic: string;
  payload: string;
} {
  if (!command.payload.includes('"method"')) return { ...command };
  const parsed = JSON.parse(command.payload) as Record<string, unknown>;
  delete parsed['id'];
  parsed['src'] = '<client>';
  return { topic: command.topic, payload: JSON.stringify(parsed) };
}

/** Entità del seed comandabili: le stesse che il pannello può toccare. */
const commandable = initialDevices.filter(
  (device) => Boolean(device.topics.command) && device.kind !== 'camera',
);

/** Annuncio Home Assistant → device con canali di comando nel discovery. */
function announced(topic: string, config: Record<string, unknown>): Device {
  const ref = parseDiscoveryTopic(topic, ['homeassistant']);
  if (!ref) throw new Error(`topic non valido: ${topic}`);
  const parsed = parseDiscoveryPayload(JSON.stringify(config));
  if (!parsed) throw new Error('payload non valido');
  const result = normalizeDiscovery(ref, parsed);
  if (!result) throw new Error('annuncio non normalizzabile');
  return result.device;
}

const announcedLight = announced('homeassistant/light/pianta/config', {
  name: 'Pianta',
  stat_t: 'z2m/pianta/state',
  cmd_t: 'z2m/pianta/set',
  bri_stat_t: 'z2m/pianta/brightness',
  bri_cmd_t: 'z2m/pianta/set/brightness',
  clr_temp_cmd_t: 'z2m/pianta/set/color_temp',
});

const announcedClimate = announced('homeassistant/climate/termo/config', {
  name: 'Termostato',
  curr_temp_t: 'casa/termo/current',
  temp_cmd_t: 'casa/termo/set/target',
  mode_cmd_t: 'casa/termo/set/mode',
});

describe('commandEncoder · parità con gli adapter del pannello', () => {
  it('copre tutti e cinque gli adapter del pannello', () => {
    const adapters = new Set([
      ...commandable.map((device) => device.adapter),
      announcedLight.adapter,
    ]);
    expect([...adapters].sort()).toEqual([
      'custom-json',
      'ha-discovery',
      'shelly',
      'tasmota',
      'zigbee2mqtt',
    ]);
  });

  it.each(commandable.map((device) => [device.id, device] as const))(
    '%s produce gli stessi comandi del client',
    (_id, device) => {
      const target = targetOf(device);
      const adapter = getAdapter(device.adapter);

      for (const action of ACTIONS) {
        const browser = adapter.encode(device, action);
        const server = encodeDeviceAction(target, action);

        // L'adapter del pannello può rifiutare l'azione (null): il motore deve
        // rifiutarla allo stesso modo, non inventare un comando.
        if (!browser) {
          expect(server, `${device.id} · ${action.type}`).toBeNull();
          continue;
        }
        expect(server, `${device.id} · ${action.type}`).not.toBeNull();
        expect(normalize(server as { topic: string; payload: string })).toEqual(
          normalize({ topic: browser.topic, payload: browser.payload }),
        );
      }
    },
  );

  it.each([announcedLight, announcedClimate])(
    'anche le entità scoperte ($id) parlano lo stesso dialetto',
    (device) => {
      const target = targetOf(device);
      const adapter = getAdapter(device.adapter);

      for (const action of ACTIONS) {
        const browser = adapter.encode(device, action);
        const server = encodeDeviceAction(target, action);
        expect(server, `${device.id} · ${action.type}`).toEqual(
          browser ? { topic: browser.topic, payload: browser.payload } : null,
        );
      }
    },
  );

  it('un device senza topic di comando non produce comandi', () => {
    const sensor = initialDevices.find((device) => device.id === 'sensor-living-temp');
    if (!sensor) throw new Error('sensor-living-temp non presente nel seed');
    const target = targetOf(sensor);

    expect(target.commandTopic).toBeNull();
    for (const action of ACTIONS) {
      // Il pannello produrrebbe un topic vuoto; il motore si ferma prima di
      // pubblicare: l'automazione lo registra come passo saltato.
      expect(encodeDeviceAction(target, action)).toBeNull();
    }
  });
});
