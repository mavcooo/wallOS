import { describe, expect, it } from 'vitest';

import {
  ROLE_LABELS,
  canAccess,
  canView,
  restrictionsFor,
} from '@/lib/permissions';

describe('permessi derivati dal ruolo', () => {
  it('admin ha accesso completo', () => {
    expect(restrictionsFor('admin', false)).toEqual({
      settings: false,
      energy: false,
      users: false,
      sensitiveActions: false,
    });
  });

  it('family limita impostazioni, profili e azioni sensibili', () => {
    expect(restrictionsFor('family', false)).toEqual({
      settings: true,
      energy: false,
      users: true,
      sensitiveActions: true,
    });
  });

  it('guest è limitato su consumi e impostazioni', () => {
    const guest = restrictionsFor('guest', false);
    expect(guest.energy).toBe(true);
    expect(guest.settings).toBe(true);
    expect(guest.users).toBe(true);
    expect(canView({ role: 'guest' }, false, 'energy')).toBe(false);
  });

  it('il kiosk sblocca impostazioni e profili solo con elevazione PIN', () => {
    expect(canView({ role: 'kiosk' }, false, 'settings')).toBe(false);
    expect(canView({ role: 'kiosk' }, false, 'users')).toBe(false);
    expect(canView({ role: 'kiosk' }, true, 'settings')).toBe(true);
    expect(canView({ role: 'kiosk' }, true, 'users')).toBe(true);

    // Il PIN non trasforma il kiosk in admin: niente consumi elevati.
    expect(canAccess({ role: 'kiosk' }, true, 'energy')).toBe(true);
    expect(restrictionsFor('kiosk', true).sensitiveActions).toBe(true);
  });

  it('l’elevazione non sblocca un guest', () => {
    expect(canView({ role: 'guest' }, true, 'settings')).toBe(false);
    expect(canView({ role: 'guest' }, true, 'users')).toBe(false);
  });

  it('espone etichette per tutti i ruoli del server', () => {
    expect(ROLE_LABELS.admin).toBe('Amministratore');
    expect(ROLE_LABELS.family).toBe('Famiglia');
    expect(ROLE_LABELS.guest).toBe('Ospite');
    expect(ROLE_LABELS.kiosk).toBe('Pannello Parete');
  });
});
