import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISCOVERY_CACHE_KEY,
  forgetDiscoveredDevice,
  mergeTopologyWithDiscovery,
  readDiscoverySnapshot,
  rememberDiscoveredDevice,
  withDiscoveredDevice,
  withoutDiscoveredDevice,
} from '@/lib/discovery';
import { useHomeStore } from '@/store/homeStore';
import { normalizeDiscovery, parseDiscoveryTopic } from '@/mqtt/discovery/normalize';
import { parseDiscoveryPayload } from '@/mqtt/discovery/types';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import type { Device } from '@/types/device';

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Device come lo produrrebbe il bridge a partire dall'annuncio HA. */
function announced(topic: string, config: Record<string, unknown>): Device {
  const ref = parseDiscoveryTopic(topic, ['homeassistant']);
  const parsed = parseDiscoveryPayload(JSON.stringify(config));
  if (!ref || !parsed) throw new Error('annuncio non valido');
  const result = normalizeDiscovery(ref, parsed);
  if (!result) throw new Error('annuncio non normalizzabile');
  return result.device;
}

const pianta = () =>
  announced('homeassistant/light/pianta/config', {
    name: 'Pianta',
    stat_t: 'casa/pianta/state',
    cmd_t: 'casa/pianta/set',
    bri_stat_t: 'casa/pianta/brightness',
    dev: { name: 'Pianta', suggested_area: 'Soggiorno' },
  });

const presaGarage = () =>
  announced('homeassistant/switch/presa/config', {
    name: 'Presa garage',
    stat_t: 'casa/presa/state',
    cmd_t: 'casa/presa/set',
    dev: { name: 'Presa', suggested_area: 'Garage' },
  });

describe('discovery · estensione della topologia in cache', () => {
  it('un’area che corrisponde a una stanza del server riusa quella stanza', () => {
    const result = withDiscoveredDevice(SEED_TOPOLOGY, pianta());

    expect(result.device.room).toBe('living');
    expect(result.topology.devices).toHaveLength(SEED_TOPOLOGY.devices.length + 1);
    expect(result.topology.rooms).toHaveLength(SEED_TOPOLOGY.rooms.length);
  });

  it('un’area sconosciuta crea una stanza nuova, una volta sola', () => {
    let topology = withDiscoveredDevice(SEED_TOPOLOGY, presaGarage()).topology;
    topology = withDiscoveredDevice(topology, pianta()).topology;

    const garage = topology.rooms.find((room) => room.label === 'Garage');
    expect(garage).toMatchObject({ id: 'garage', label: 'Garage' });
    expect(topology.devices.find((device) => device.id === 'ha:switch:presa')?.room).toBe(
      'garage',
    );
    expect(topology.rooms.filter((room) => room.id === 'garage')).toHaveLength(1);
  });

  it('senza suggested_area il device finisce in “Non assegnati”', () => {
    const sensore = announced('homeassistant/sensor/temp/config', {
      name: 'Temperatura',
      stat_t: 'casa/temp',
      dev_cla: 'temperature',
      unit_of_meas: '°C',
    });

    const result = withDiscoveredDevice(SEED_TOPOLOGY, sensore);

    expect(result.device.room).toBe('unassigned');
  });

  it('un re-annuncio aggiorna i metadati ma non azzera lo stato runtime', () => {
    const device = pianta();
    const first = withDiscoveredDevice(SEED_TOPOLOGY, device);
    useHomeStore.getState().syncDeviceStates(first.topology.devices);
    useHomeStore.getState().toggleFavorite('ha:light:pianta');
    useHomeStore
      .getState()
      .applyDecoded('ha:light:pianta', { kind: 'light', state: { brightness: 88 } });

    // Retained che arriva al reconnect: stessa entità, stessa configurazione.
    const second = withDiscoveredDevice(first.topology, device);
    useHomeStore.getState().syncDeviceStates(second.topology.devices);

    const row = useHomeStore.getState().deviceStates['ha:light:pianta'];
    expect(row?.favorite).toBe(true);
    expect(row?.kind === 'light' && row.state.brightness).toBe(88);
  });

  it('la rimozione elimina solo l’entità ritirata e conserva la stanza', () => {
    let topology = withDiscoveredDevice(SEED_TOPOLOGY, presaGarage()).topology;
    topology = withDiscoveredDevice(topology, pianta()).topology;

    const next = withoutDiscoveredDevice(topology, 'ha:light:pianta');

    expect(next.devices.some((device) => device.id === 'ha:light:pianta')).toBe(false);
    expect(next.devices.some((device) => device.id === 'ha:switch:presa')).toBe(true);
    // La stanza resta: può ospitare altre entità o essere riusata.
    expect(next.rooms.some((room) => room.id === 'garage')).toBe(true);
  });

  it('rimuovere un’entità sconosciuta non cambia la topologia', () => {
    expect(withoutDiscoveredDevice(SEED_TOPOLOGY, 'ha:light:inesistente')).toBe(
      SEED_TOPOLOGY,
    );
  });
});

describe('discovery · cache locale delle entità scoperte', () => {
  it('persiste device e stanze e li riapplica al prossimo bootstrap', () => {
    const result = withDiscoveredDevice(SEED_TOPOLOGY, presaGarage());
    rememberDiscoveredDevice(result.device, result.room);

    // Il backend non conosce l'entità: la risposta HTTP viene fusa con la cache.
    const merged = mergeTopologyWithDiscovery(SEED_TOPOLOGY);

    expect(merged.devices.some((device) => device.id === 'ha:switch:presa')).toBe(true);
    expect(merged.rooms.some((room) => room.id === 'garage')).toBe(true);
    expect(readDiscoverySnapshot().devices).toHaveLength(1);
  });

  it('non scrive i device del server nella cache della discovery', () => {
    mergeTopologyWithDiscovery(SEED_TOPOLOGY);

    const raw = localStorage.getItem(DISCOVERY_CACHE_KEY) ?? '';
    expect(raw).not.toContain('light-living-main');
  });

  it('forget rimuove l’entità ma lascia la stanza disponibile', () => {
    const result = withDiscoveredDevice(SEED_TOPOLOGY, presaGarage());
    rememberDiscoveredDevice(result.device, result.room);

    forgetDiscoveredDevice('ha:switch:presa');

    const snapshot = readDiscoverySnapshot();
    expect(snapshot.devices).toHaveLength(0);
    expect(snapshot.rooms.some((room) => room.id === 'garage')).toBe(true);
  });

  it('tollera una cache corrotta senza bloccare il bootstrap', () => {
    localStorage.setItem(DISCOVERY_CACHE_KEY, 'non-json');

    expect(readDiscoverySnapshot()).toEqual({ devices: [], rooms: [] });
    expect(mergeTopologyWithDiscovery(SEED_TOPOLOGY).devices).toHaveLength(
      SEED_TOPOLOGY.devices.length,
    );
  });
});
