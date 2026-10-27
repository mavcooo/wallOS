import { beforeEach, describe, expect, it } from 'vitest';

import {
  generateKioskId,
  getKioskId,
  KIOSK_ID_COOKIE,
  KIOSK_ID_STORAGE_KEY,
  resetKioskIdCache,
  sanitizeKioskId,
  setKioskId,
} from '@/utils/kioskIdentity';

function clearIdentity(): void {
  localStorage.clear();
  // Il cookie si cancella scrivendo una scadenza nel passato sullo stesso path.
  document.cookie = `${KIOSK_ID_COOKIE}=; Max-Age=0; Path=/`;
  resetKioskIdCache();
}

beforeEach(clearIdentity);

describe('kioskIdentity · primo avvio', () => {
  it('genera un id `kiosk_…` e lo salva in localStorage e nel cookie', () => {
    const id = getKioskId();

    expect(id.startsWith('kiosk_')).toBe(true);
    expect(localStorage.getItem(KIOSK_ID_STORAGE_KEY)).toBe(id);
    expect(document.cookie).toContain(`${KIOSK_ID_COOKIE}=${encodeURIComponent(id)}`);
  });

  it('restituisce sempre lo stesso id nelle chiamate successive', () => {
    const first = getKioskId();
    expect(getKioskId()).toBe(first);
  });

  it('due installazioni diverse ricevono id diversi', () => {
    const first = getKioskId();
    clearIdentity();
    expect(getKioskId()).not.toBe(first);
  });
});

describe('kioskIdentity · persistenza', () => {
  it('se lo storage locale viene svuotato resta il cookie', () => {
    const id = getKioskId();
    localStorage.clear();
    resetKioskIdCache();

    expect(getKioskId()).toBe(id);
    // L'id letto dal cookie viene ricopiato nello storage.
    expect(localStorage.getItem(KIOSK_ID_STORAGE_KEY)).toBe(id);
  });

  it('se resta solo il localStorage il cookie viene riscritto', () => {
    const id = getKioskId();
    document.cookie = `${KIOSK_ID_COOKIE}=; Max-Age=0; Path=/`;
    resetKioskIdCache();

    expect(getKioskId()).toBe(id);
    expect(document.cookie).toContain(`${KIOSK_ID_COOKIE}=${encodeURIComponent(id)}`);
  });

  it('un cookie malformato viene ignorato e sostituito', () => {
    document.cookie = `${KIOSK_ID_COOKIE}=${encodeURIComponent('id con spazi')}; Path=/`;
    resetKioskIdCache();

    const id = getKioskId();
    expect(id).not.toBe('id con spazi');
    expect(sanitizeKioskId(id)).toBe(id);
  });
});

describe('kioskIdentity · rinomina', () => {
  it('accetta un id scelto dall’amministratore e aggiorna entrambi i contenitori', () => {
    const applied = setKioskId('tablet_ingresso');

    expect(applied).toBe('tablet_ingresso');
    expect(getKioskId()).toBe('tablet_ingresso');
    expect(localStorage.getItem(KIOSK_ID_STORAGE_KEY)).toBe('tablet_ingresso');
    expect(document.cookie).toContain(`${KIOSK_ID_COOKIE}=tablet_ingresso`);
  });

  it('rifiuta id non validi senza toccare quello in uso', () => {
    const current = getKioskId();

    expect(setKioskId('pannello cucina')).toBeNull();
    expect(setKioskId('cucina/tablet')).toBeNull();
    expect(setKioskId('')).toBeNull();
    expect(getKioskId()).toBe(current);
  });
});

describe('kioskIdentity · formato', () => {
  it('accetta lettere, cifre, punto, trattino, due punti e underscore', () => {
    for (const value of ['kiosk_abc', 'tablet-1', 'panel.living', 'sala:1']) {
      expect(sanitizeKioskId(value)).toBe(value);
    }
  });

  it('rifiuta valori oltre 64 caratteri o con caratteri non ammessi', () => {
    expect(sanitizeKioskId('a'.repeat(65))).toBeNull();
    expect(sanitizeKioskId('tab let')).toBeNull();
    expect(sanitizeKioskId('-leading-dash')).toBeNull();
    expect(sanitizeKioskId(null)).toBeNull();
  });

  it('taglia gli spazi ai bordi', () => {
    expect(sanitizeKioskId('  tablet_1  ')).toBe('tablet_1');
  });

  it('genera id univoci e conformi al formato', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateKioskId()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(sanitizeKioskId(id)).toBe(id);
  });
});
