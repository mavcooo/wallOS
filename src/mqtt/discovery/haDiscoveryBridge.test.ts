import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHaDiscoveryBridge } from '@/mqtt/discovery/haDiscoveryBridge';
import type { Device } from '@/types/device';

const CONFIG = (objectId: string, area?: string) =>
  JSON.stringify({
    name: objectId,
    stat_t: `casa/${objectId}/state`,
    // Un sensore senza device_class né unità viene scartato dal normalizzatore.
    dev_cla: 'temperature',
    dev: { name: objectId, ...(area ? { suggested_area: area } : {}) },
  });

function setup(prefixes: readonly string[] = ['homeassistant']) {
  const upserted: Device[] = [];
  const removed: string[] = [];
  const bridge = createHaDiscoveryBridge({
    prefixes,
    flushDelayMs: 200,
    onUpsert: (device) => upserted.push(device),
    onRemove: (entityId) => removed.push(entityId),
  });
  return { bridge, upserted, removed };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHaDiscoveryBridge', () => {
  it('riconosce solo i topic di discovery dei prefissi configurati', () => {
    const { bridge } = setup();

    expect(bridge.matches('homeassistant/light/pianta/config')).toBe(true);
    expect(bridge.matches('homeassistant/sensor/0x1/temp/config')).toBe(true);
    expect(bridge.matches('homeassistant/light/pianta/state')).toBe(false);
    expect(bridge.matches('zigbee2mqtt/light/pianta/config')).toBe(false);
  });

  it('supporta prefissi custom', () => {
    const { bridge, upserted } = setup(['homeassistant', 'zigbee2mqtt']);

    bridge.handleMessage('zigbee2mqtt/switch/presa/config', CONFIG('presa'));
    bridge.flush();

    expect(upserted.map((device) => device.id)).toEqual(['ha:switch:presa']);
  });

  it('accorpa la raffica di retained in un solo flush', () => {
    const { bridge, upserted } = setup();

    bridge.handleMessage('homeassistant/light/a/config', CONFIG('a', 'Soggiorno'));
    bridge.handleMessage('homeassistant/light/b/config', CONFIG('b'));
    bridge.handleMessage('homeassistant/sensor/c/config', CONFIG('c'));

    // Ancora nulla: la registrazione è in finestra di debounce.
    expect(upserted).toHaveLength(0);

    vi.advanceTimersByTime(200);
    expect(upserted.map((device) => device.id)).toEqual([
      'ha:light:a',
      'ha:light:b',
      'ha:sensor:c',
    ]);
  });

  it('aggiorna la stessa entità una volta sola nell’arco della finestra', () => {
    const { bridge, upserted } = setup();

    bridge.handleMessage('homeassistant/light/a/config', CONFIG('a'));
    bridge.handleMessage('homeassistant/light/a/config', CONFIG('a', 'Cucina'));
    vi.advanceTimersByTime(200);

    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.discovery?.area).toBe('Cucina');
  });

  it('rimuove l’entità con payload vuoto, come da specifica', () => {
    const { bridge, upserted, removed } = setup();

    bridge.handleMessage('homeassistant/light/a/config', CONFIG('a'));
    vi.advanceTimersByTime(200);
    expect(upserted).toHaveLength(1);

    bridge.handleMessage('homeassistant/light/a/config', '');
    vi.advanceTimersByTime(200);

    expect(removed).toEqual(['ha:light:a']);
  });

  it('se l’entità viene ritirata prima del flush vince la rimozione', () => {
    const { bridge, upserted, removed } = setup();

    bridge.handleMessage('homeassistant/light/a/config', CONFIG('a'));
    bridge.handleMessage('homeassistant/light/a/config', '');
    vi.advanceTimersByTime(200);

    expect(upserted).toHaveLength(0);
    expect(removed).toEqual(['ha:light:a']);
  });

  it('ignora payload malformati e componenti non supportati', () => {
    const { bridge, upserted, removed } = setup();

    bridge.handleMessage('homeassistant/light/rotta/config', '{non-json');
    bridge.handleMessage('homeassistant/cover/tapparella/config', CONFIG('tapparella'));
    vi.advanceTimersByTime(200);

    expect(upserted).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it('flush() applica subito senza attendere il timer; dispose() scarta il resto', () => {
    const { bridge, upserted } = setup();

    bridge.handleMessage('homeassistant/light/a/config', CONFIG('a'));
    bridge.flush();
    expect(upserted).toHaveLength(1);

    bridge.handleMessage('homeassistant/light/b/config', CONFIG('b'));
    bridge.dispose();
    vi.advanceTimersByTime(1_000);
    expect(upserted).toHaveLength(1);
  });
});
