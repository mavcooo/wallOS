import { describe, expect, it, vi } from 'vitest';

import {
  emitKioskConfig,
  isKioskConfigTopic,
  kioskConfigTopic,
  kioskIdFromTopic,
  onKioskConfig,
  parseKioskConfig,
} from '@/mqtt/kioskEvents';
import type { KioskDisplay } from '@/types/kiosk';

const ID = 'kiosk_1234';

function display(overrides: Partial<KioskDisplay> = {}): KioskDisplay {
  return {
    id: ID,
    name: 'Pannello Ingresso',
    defaultRoomId: 'living',
    dimmerTimeoutSec: 300,
    dimmerScreensaverMode: 'clock_float',
    performanceMode: false,
    highContrast: true,
    pinRequired: true,
    screenOrientation: 'landscape',
    isActive: true,
    lastSeenAt: null,
    createdAt: 1,
    updatedAt: 2,
    online: false,
    ...overrides,
  };
}

/** Payload pubblicato dal server: `{ id, config, timestamp }`. */
function payload(config: KioskDisplay = display()): string {
  return JSON.stringify({ id: ID, config, timestamp: Date.now() });
}

describe('kioskEvents · topic', () => {
  it('costruisce il topic del pannello', () => {
    expect(kioskConfigTopic(ID)).toBe(`wallos/system/kiosk/${ID}/config_updated`);
  });

  it('riconosce solo i topic di configurazione display', () => {
    expect(isKioskConfigTopic(`wallos/system/kiosk/${ID}/config_updated`)).toBe(true);
    expect(isKioskConfigTopic('wallos/system/topology_changed')).toBe(false);
    expect(isKioskConfigTopic(`wallos/system/kiosk/${ID}/other`)).toBe(false);
    expect(isKioskConfigTopic(`other/wallos/system/kiosk/${ID}/config_updated`)).toBe(false);
  });

  it('estrae l’id dal topic', () => {
    expect(kioskIdFromTopic(`wallos/system/kiosk/${ID}/config_updated`)).toBe(ID);
    expect(kioskIdFromTopic('wallos/system/kiosk/config_updated')).toBeNull();
    expect(kioskIdFromTopic(`wallos/system/kiosk/a/b/config_updated`)).toBeNull();
    expect(kioskIdFromTopic('wallos/system/topology_changed')).toBeNull();
  });
});

describe('kioskEvents · parsing', () => {
  it('legge la configurazione con l’id del topic', () => {
    const event = parseKioskConfig(`wallos/system/kiosk/${ID}/config_updated`, payload());

    expect(event?.id).toBe(ID);
    expect(event?.config.name).toBe('Pannello Ingresso');
    expect(event?.config.dimmerTimeoutSec).toBe(300);
  });

  it('scarta payload non JSON o senza configurazione', () => {
    const topic = `wallos/system/kiosk/${ID}/config_updated`;
    expect(parseKioskConfig(topic, 'non-json')).toBeNull();
    expect(parseKioskConfig(topic, JSON.stringify({ id: ID }))).toBeNull();
    expect(parseKioskConfig(topic, JSON.stringify([1, 2]))).toBeNull();
  });

  it('scarta una configurazione che dichiara un altro display', () => {
    const topic = `wallos/system/kiosk/${ID}/config_updated`;
    expect(
      parseKioskConfig(topic, JSON.stringify({ id: ID, config: display({ id: 'altro' }) })),
    ).toBeNull();
  });

  it('ignora i topic che non sono di configurazione', () => {
    expect(parseKioskConfig('wallos/system/topology_changed', payload())).toBeNull();
  });
});

describe('kioskEvents · bus', () => {
  it('consegna gli eventi agli ascoltatori e li rimuove al cleanup', () => {
    const listener = vi.fn();
    const off = onKioskConfig(listener);

    emitKioskConfig({ id: ID, config: display() });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].id).toBe(ID);

    off();
    emitKioskConfig({ id: ID, config: display() });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
