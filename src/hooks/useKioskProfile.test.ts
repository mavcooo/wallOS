import { beforeEach, describe, expect, it } from 'vitest';

import { applyKioskConfig } from '@/hooks/useKioskProfile';
import { applyContrastAttribute } from '@/lib/contrast';
import {
  applyKioskOrientation,
  isKioskPinRequired,
  resetKioskPinRequired,
  setKioskPinRequired,
} from '@/lib/kioskPolicy';
import { applyPerformanceMode } from '@/lib/performance';
import { useContrastStore } from '@/store/contrastStore';
import { useHomeStore } from '@/store/homeStore';
import type { KioskDisplay } from '@/types/kiosk';

function display(overrides: Partial<KioskDisplay> = {}): KioskDisplay {
  return {
    id: 'kiosk_1',
    name: 'Pannello Ingresso',
    defaultRoomId: 'living',
    dimmerTimeoutSec: 300,
    dimmerScreensaverMode: 'clock_float',
    performanceMode: false,
    highContrast: false,
    pinRequired: true,
    screenOrientation: 'landscape',
    isActive: true,
    lastSeenAt: Date.now(),
    createdAt: 1,
    updatedAt: 2,
    online: true,
    ...overrides,
  };
}

beforeEach(() => {
  useHomeStore.getState().setDimmerTimeout(120_000);
  useHomeStore.getState().setPerformanceMode(false);
  applyPerformanceMode(false);
  useContrastStore.getState().setPreference('auto');
  applyContrastAttribute(false);
  resetKioskPinRequired();
  delete document.documentElement.dataset.kioskOrientation;
});

describe('applyKioskConfig', () => {
  it('trasferisce il timeout del dimmer in millisecondi nello store', () => {
    applyKioskConfig(display({ dimmerTimeoutSec: 300 }));
    expect(useHomeStore.getState().ui.dimmerTimeoutMs).toBe(300_000);
  });

  it('attiva alto contrasto, performance mode e attributi sul documento', () => {
    applyKioskConfig(display({ highContrast: true, performanceMode: true }));

    expect(useContrastStore.getState().preference).toBe('on');
    expect(document.documentElement.dataset.contrast).toBe('high');
    expect(useHomeStore.getState().ui.performanceMode).toBe(true);
    expect(document.documentElement.dataset.performanceMode).toBe('true');
  });

  it('disattiva alto contrasto e performance mode quando il server li spegne', () => {
    applyKioskConfig(display({ highContrast: true, performanceMode: true }));
    applyKioskConfig(display({ highContrast: false, performanceMode: false, updatedAt: 3 }));

    expect(useContrastStore.getState().preference).toBe('off');
    expect(document.documentElement.dataset.contrast).toBe('normal');
    expect(useHomeStore.getState().ui.performanceMode).toBe(false);
    expect(document.documentElement.dataset.performanceMode).toBeUndefined();
  });

  it('applica `pin_required` e l’orientamento dichiarati dal server', () => {
    applyKioskConfig(display({ pinRequired: false, screenOrientation: 'portrait' }));

    expect(isKioskPinRequired()).toBe(false);
    expect(document.documentElement.dataset.kioskOrientation).toBe('portrait');

    applyKioskConfig(display({ pinRequired: true, screenOrientation: 'landscape', updatedAt: 4 }));
    expect(isKioskPinRequired()).toBe(true);
    expect(document.documentElement.dataset.kioskOrientation).toBe('landscape');
  });

  it('non è idempotente sullo stato locale: è sempre il server a vincere', () => {
    applyKioskConfig(display({ dimmerTimeoutSec: 600 }));
    useHomeStore.getState().setDimmerTimeout(60_000);
    applyKioskConfig(display({ dimmerTimeoutSec: 600 }));

    expect(useHomeStore.getState().ui.dimmerTimeoutMs).toBe(600_000);
  });
});

describe('kioskPolicy', () => {
  it('parte con il PIN richiesto', () => {
    expect(isKioskPinRequired()).toBe(true);
    setKioskPinRequired(false);
    expect(isKioskPinRequired()).toBe(false);
  });

  it('scrive l’attributo di orientamento anche senza API Screen Orientation', () => {
    applyKioskOrientation('portrait');
    expect(document.documentElement.dataset.kioskOrientation).toBe('portrait');
  });
});
