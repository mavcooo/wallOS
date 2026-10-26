import { describe, expect, it, vi } from 'vitest';

import {
  emitTopologyChanged,
  onTopologyChanged,
  parseTopologyChanged,
  TOPOLOGY_CHANGED_TOPIC,
  type TopologyChangedEvent,
} from '@/mqtt/topologyEvents';

function payloadOf(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'device_updated',
    entity: 'device',
    id: 'light-living-main',
    timestamp: 1_730_000_000_000,
    ...overrides,
  });
}

describe('TOPOLOGY_CHANGED_TOPIC', () => {
  it('coincide con il topic pubblicato dal server', () => {
    expect(TOPOLOGY_CHANGED_TOPIC).toBe('wallos/system/topology_changed');
  });
});

describe('parseTopologyChanged', () => {
  it('accetta il payload completo del server', () => {
    expect(parseTopologyChanged(payloadOf({ sourceClientId: 'admin-pc' }))).toEqual({
      event: 'device_updated',
      entity: 'device',
      id: 'light-living-main',
      timestamp: 1_730_000_000_000,
      sourceClientId: 'admin-pc',
    });
  });

  it('accetta le entità previste anche senza sourceClientId', () => {
    for (const entity of ['room', 'device', 'scenario']) {
      const parsed = parseTopologyChanged(payloadOf({ entity, event: `${entity}_created` }));
      expect(parsed?.entity).toBe(entity);
      expect(parsed?.sourceClientId).toBeUndefined();
    }
  });

  it('ricompone il timestamp mancante', () => {
    const parsed = parseTopologyChanged(payloadOf({ timestamp: undefined }));
    expect(parsed?.timestamp).toBeGreaterThan(0);
  });

  it('scarta payload malformati: nessun refetch spurio', () => {
    expect(parseTopologyChanged('non-json')).toBeNull();
    expect(parseTopologyChanged('[]')).toBeNull();
    expect(parseTopologyChanged('null')).toBeNull();
    expect(parseTopologyChanged('{}')).toBeNull();
    expect(parseTopologyChanged(payloadOf({ event: '' }))).toBeNull();
    // Entità ignota: il payload non è nostro, non genera invalidazioni.
    expect(parseTopologyChanged(payloadOf({ entity: 'garage' }))).toBeNull();
    expect(parseTopologyChanged(payloadOf({ id: '' }))).toBeNull();
  });
});

describe('bus degli eventi', () => {
  it('notifica i listener registrati e rispetta l\'unsubscribe', () => {
    const received: TopologyChangedEvent[] = [];
    const listener = vi.fn((event: TopologyChangedEvent) => received.push(event));
    const unsubscribe = onTopologyChanged(listener);

    const event = parseTopologyChanged(payloadOf())!;
    emitTopologyChanged(event);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(received).toEqual([event]);

    unsubscribe();
    emitTopologyChanged(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
