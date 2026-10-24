import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHomeStore } from '@/store/homeStore';
import { resetBrowserStorage } from '@/test/browserEnv';
import { SEED_TOPOLOGY } from '@/test/fixtures';

beforeEach(() => {
  resetBrowserStorage();
  useHomeStore.setState({ deviceStates: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('store · bootstrap delle righe realtime', () => {
  it('parte senza device: nessuna anagrafica compilata nel bundle', () => {
    const state = useHomeStore.getState();

    expect(state.deviceStates).toEqual({});
    // La topologia non è più stato client.
    expect(state).not.toHaveProperty('devices');
    expect(state).not.toHaveProperty('rooms');
    expect(state).not.toHaveProperty('scenarios');
    expect(state).not.toHaveProperty('topologyStatus');
  });

  it('semina le righe dallo snapshot del server, indicizzate per id', () => {
    useHomeStore.getState().syncDeviceStates(SEED_TOPOLOGY.devices);

    const states = useHomeStore.getState().deviceStates;
    expect(Object.keys(states)).toHaveLength(SEED_TOPOLOGY.devices.length);

    const seed = SEED_TOPOLOGY.devices.find((device) => device.id === 'light-living-main');
    expect(states['light-living-main']).toMatchObject({
      id: 'light-living-main',
      kind: 'light',
      state: seed?.state,
      availability: seed?.availability,
      isOptimistic: false,
    });
  });

  it('un nuovo sync conserva le righe aggiornate e rimuove i device spariti', () => {
    useHomeStore.getState().syncDeviceStates(SEED_TOPOLOGY.devices);
    useHomeStore
      .getState()
      .applyDecoded('light-living-main', { kind: 'light', state: { brightness: 12 } });
    const kept = useHomeStore.getState().deviceStates['light-living-main'];

    const subset = SEED_TOPOLOGY.devices.filter(
      (device) => device.id !== 'power-kitchen-oven',
    );
    useHomeStore.getState().syncDeviceStates(subset);

    // Stesso riferimento: nessun render per i device non toccati.
    expect(useHomeStore.getState().deviceStates['light-living-main']).toBe(kept);
    expect(useHomeStore.getState().deviceStates['power-kitchen-oven']).toBeUndefined();
  });

  it('updateDeviceState è una patch O(1) che non ricrea le altre righe', () => {
    useHomeStore.getState().syncDeviceStates(SEED_TOPOLOGY.devices);
    const other = useHomeStore.getState().deviceStates['climate-living'];

    useHomeStore
      .getState()
      .setAvailability('light-living-main', 'offline');

    const states = useHomeStore.getState().deviceStates;
    expect(states['light-living-main']?.availability).toBe('offline');
    expect(states['light-living-main']?.lastUpdated).toBeGreaterThan(0);
    expect(states['climate-living']).toBe(other);

    // Id sconosciuto: nessuna scrittura, nessuna eccezione.
    const before = useHomeStore.getState().deviceStates;
    useHomeStore.getState().updateDeviceState('sconosciuto', { favorite: true });
    expect(useHomeStore.getState().deviceStates).toBe(before);
  });
});

describe('topologyApi · errori', () => {
  it('un gateway 503 produce un messaggio con lo status per il retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    const { fetchTopology } = await import('@/lib/topologyApi');

    await expect(fetchTopology()).rejects.toThrow('503');
  });
});
