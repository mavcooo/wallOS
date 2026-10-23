import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeDiscovery, parseDiscoveryTopic } from '@/mqtt/discovery/normalize';
import { parseDiscoveryPayload } from '@/mqtt/discovery/types';
import type { Device } from '@/types/device';

const STORAGE_KEY = 'domus-kiosk-store';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.resetModules();
});

/** Device come lo produrrebbe il bridge a partire dall'annuncio HA. */
function announced(
  topic: string,
  config: Record<string, unknown>,
): Device {
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

async function loadStore() {
  vi.resetModules();
  const { useHomeStore } = await import('@/store/homeStore');
  // Bootstrap come in produzione: la topologia arriva dal server, non da un file.
  const { SEED_TOPOLOGY } = await import('@/test/fixtures');
  useHomeStore.getState().hydrateTopology(SEED_TOPOLOGY);
  return useHomeStore;
}

describe('store · device scoperti e stanze', () => {
  it('un’area che corrisponde a una stanza del seed riusa quella stanza', async () => {
    const store = await loadStore();
    const device = pianta();

    store.getState().applyDiscoveryUpsert(device);

    const saved = store.getState().devices['ha:light:pianta'];
    expect(saved?.room).toBe('living');
    expect(store.getState().rooms).toHaveLength(7); // 6 seed + “Non assegnati”
  });

  it('un’area sconosciuta crea una stanza nuova, una volta sola', async () => {
    const store = await loadStore();

    store.getState().applyDiscoveryUpsert(presaGarage());
    store.getState().applyDiscoveryUpsert(pianta());

    const garage = store.getState().rooms.find((room) => room.label === 'Garage');
    expect(garage).toMatchObject({ id: 'garage', label: 'Garage' });
    expect(store.getState().devices['ha:switch:presa']?.room).toBe('garage');
    expect(store.getState().rooms.filter((room) => room.id === 'garage')).toHaveLength(1);
  });

  it('senza suggested_area il device finisce in “Non assegnati”', async () => {
    const store = await loadStore();
    const sensore = announced('homeassistant/sensor/temp/config', {
      name: 'Temperatura',
      stat_t: 'casa/temp',
      dev_cla: 'temperature',
      unit_of_meas: '°C',
    });

    store.getState().applyDiscoveryUpsert(sensore);

    expect(store.getState().devices['ha:sensor:temp']?.room).toBe('unassigned');
  });

  it('un re-annuncio aggiorna i metadati ma non azzera stato e preferito', async () => {
    const store = await loadStore();
    const device = pianta();

    store.getState().applyDiscoveryUpsert(device);
    store.getState().toggleFavorite('ha:light:pianta');
    store.getState().applyDecoded('ha:light:pianta', { kind: 'light', state: { brightness: 88 } });

    // Retained che arriva al reconnect: stessa entità, stessa configurazione.
    store.getState().applyDiscoveryUpsert(device);

    const saved = store.getState().devices['ha:light:pianta'];
    expect(saved?.favorite).toBe(true);
    expect(saved?.kind === 'light' && saved.state.brightness).toBe(88);
  });

  it('la rimozione elimina solo l’entità ritirata', async () => {
    const store = await loadStore();
    store.getState().applyDiscoveryUpsert(pianta());
    store.getState().applyDiscoveryUpsert(presaGarage());

    store.getState().applyDiscoveryRemove('ha:light:pianta');

    expect(store.getState().devices['ha:light:pianta']).toBeUndefined();
    expect(store.getState().devices['ha:switch:presa']).toBeDefined();
    // La stanza resta: può ospitare altre entità o essere riusata.
    expect(store.getState().rooms.some((room) => room.id === 'garage')).toBe(true);
  });

  it('rimuovere un’entità sconosciuta non cambia nulla', async () => {
    const store = await loadStore();
    const before = store.getState().devices;

    store.getState().applyDiscoveryRemove('ha:light:inesistente');

    expect(store.getState().devices).toBe(before);
  });
});

describe('store · cache dei device scoperti', () => {
  it('persiste device e stanze e li rilegge al riavvio', async () => {
    const first = await loadStore();
    first.getState().applyDiscoveryUpsert(presaGarage());

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toContain('ha:switch:presa');

    const reloaded = await loadStore();
    const cached = reloaded.getState().devices['ha:switch:presa'];

    expect(cached).toBeDefined();
    // La disponibilità di una sessione fa non vale più finché il broker parla.
    expect(cached?.availability).toBe('unknown');
    expect(reloaded.getState().rooms.some((room) => room.id === 'garage')).toBe(true);
  });

  it('lega i device statici dal seed e non li duplica dalla cache', async () => {
    const store = await loadStore();

    expect(store.getState().devices['light-living-main']?.discovery).toBeUndefined();
    expect(
      localStorage.getItem(STORAGE_KEY) ?? '',
      'il seed non deve finire in cache',
    ).not.toContain('light-living-main');
  });

  it('tollera uno stato persistito della vecchia versione (senza stanze né cache)', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { broker: { host: 'vecchio.casa.lan' } }, version: 1 }),
    );

    const store = await loadStore();

    expect(store.getState().broker.host).toBe('vecchio.casa.lan');
    expect(store.getState().rooms).toHaveLength(7);
    expect(store.getState().devices['light-living-main']).toBeDefined();
  });
});
