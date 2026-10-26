import { describe, expect, it } from 'vitest';

import { parseAvailabilityPayload } from '@/lib/availability';

describe('parseAvailabilityPayload · formati LWT per ecosistema', () => {
  it('legge i payload Tasmota (tele/<device>/LWT)', () => {
    expect(parseAvailabilityPayload('Online')).toBe('online');
    expect(parseAvailabilityPayload('Offline')).toBe('offline');
    // Tasmota pubblica anche con spazi o maiuscole miste.
    expect(parseAvailabilityPayload(' ONLINE ')).toBe('online');
  });

  it('legge i payload Shelly Gen1/Gen2 (true/false, online/offline)', () => {
    expect(parseAvailabilityPayload('true')).toBe('online');
    expect(parseAvailabilityPayload('false')).toBe('offline');
    expect(parseAvailabilityPayload('1')).toBe('online');
    expect(parseAvailabilityPayload('0')).toBe('offline');
  });

  it('legge il JSON di Zigbee2MQTT', () => {
    expect(parseAvailabilityPayload('{"state":"online"}')).toBe('online');
    expect(parseAvailabilityPayload('{"state":"offline"}')).toBe('offline');
    // Alcune versioni usano un booleano dentro l'oggetto.
    expect(parseAvailabilityPayload('{"availability":true}')).toBe('online');
  });

  it('dà precedenza ai payload dichiarati dal device', () => {
    const options = { payloadOnline: 'UP', payloadOffline: 'DOWN' };
    expect(parseAvailabilityPayload('UP', options)).toBe('online');
    expect(parseAvailabilityPayload('DOWN', options)).toBe('offline');
    // Un payload non dichiarato ma noto resta valido come fallback.
    expect(parseAvailabilityPayload('1', options)).toBe('online');
  });

  it('scarta i payload ambigui o vuoti senza cambiare stato', () => {
    expect(parseAvailabilityPayload('')).toBeNull();
    expect(parseAvailabilityPayload('   ')).toBeNull();
    expect(parseAvailabilityPayload('{')).toBeNull();
    expect(parseAvailabilityPayload('{"state":"boh"}')).toBeNull();
    // Retained vuoto del broker: non deve spegnere il device.
    expect(parseAvailabilityPayload('{}')).toBeNull();
  });
});
