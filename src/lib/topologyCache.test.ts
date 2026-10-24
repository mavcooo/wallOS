import { beforeEach, describe, expect, it } from 'vitest';

import {
  TOPOLOGY_CACHE_KEY,
  TOPOLOGY_CACHE_MAX_AGE_MS,
  clearTopologyCache,
  readTopologyCache,
  saveTopologyCache,
} from '@/lib/topologyCache';
import { SEED_TOPOLOGY } from '@/test/fixtures';

beforeEach(() => {
  localStorage.clear();
});

describe('topologyCache', () => {
  it('salva e rilegge la topologia con il timestamp', () => {
    const entry = saveTopologyCache(SEED_TOPOLOGY, 1_700_000_000_000);

    expect(entry.savedAt).toBe(1_700_000_000_000);
    expect(readTopologyCache(1_700_000_000_500)).toEqual(entry);
    expect(readTopologyCache(1_700_000_000_500)?.topology.devices).toHaveLength(
      SEED_TOPOLOGY.devices.length,
    );
  });

  it('scarta una cache più vecchia del limite', () => {
    saveTopologyCache(SEED_TOPOLOGY, 1_700_000_000_000);

    const expired = 1_700_000_000_000 + TOPOLOGY_CACHE_MAX_AGE_MS + 1;
    expect(readTopologyCache(expired)).toBeNull();
  });

  it('ignora JSON corrotto, timestamp mancante e topologia malformata', () => {
    localStorage.setItem(TOPOLOGY_CACHE_KEY, '{not json');
    expect(readTopologyCache()).toBeNull();

    localStorage.setItem(TOPOLOGY_CACHE_KEY, JSON.stringify({ topology: SEED_TOPOLOGY }));
    expect(readTopologyCache()).toBeNull();

    localStorage.setItem(
      TOPOLOGY_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), topology: { rooms: [] } }),
    );
    expect(readTopologyCache()).toBeNull();
  });

  it('cancella la cache salvata', () => {
    saveTopologyCache(SEED_TOPOLOGY);
    clearTopologyCache();

    expect(localStorage.getItem(TOPOLOGY_CACHE_KEY)).toBeNull();
    expect(readTopologyCache()).toBeNull();
  });
});
