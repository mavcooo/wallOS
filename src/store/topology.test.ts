import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBrowserStorage } from '@/test/browserEnv';
import { SEED_TOPOLOGY } from '@/test/fixtures';

beforeEach(() => {
  resetBrowserStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadStore() {
  vi.resetModules();
  const { useHomeStore } = await import('@/store/homeStore');
  return useHomeStore;
}

describe('store · bootstrap della topologia dal server', () => {
  it('parte vuoto: nessun device o stanza compilata nel bundle', async () => {
    const store = await loadStore();

    expect(store.getState().devices).toEqual({});
    expect(store.getState().rooms).toEqual([]);
    expect(store.getState().scenarios).toEqual([]);
    expect(store.getState().topologyStatus).toBe('idle');
  });

  it('idrata device, stanze e scenari da GET /api/topology', async () => {
    const store = await loadStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(SEED_TOPOLOGY), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await store.getState().loadTopology();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/topology',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(store.getState().topologyStatus).toBe('ready');
    expect(Object.keys(store.getState().devices)).toHaveLength(SEED_TOPOLOGY.devices.length);
    expect(store.getState().rooms).toHaveLength(SEED_TOPOLOGY.rooms.length);
    expect(store.getState().scenarios).toHaveLength(SEED_TOPOLOGY.scenarios.length);
    expect(store.getState().devices['light-living-main']?.room).toBe('living');
  });

  it('in errore non monta una casa finta: stato error e messaggio per il retry', async () => {
    const store = await loadStore();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

    await store.getState().loadTopology();

    expect(store.getState().topologyStatus).toBe('error');
    expect(store.getState().topologyError).toContain('503');
    expect(store.getState().devices).toEqual({});
  });
});
