import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useBatteryStatus } from '@/hooks/useBatteryStatus';
import { installFakeBattery, removeFakeBattery } from '@/test/battery';

afterEach(() => {
  removeFakeBattery();
});

describe('useBatteryStatus', () => {
  it('legge livello e stato di alimentazione dal browser', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.72;
    battery.charging = true;
    battery.chargingTime = 1_800;
    battery.dischargingTime = Number.POSITIVE_INFINITY;

    const { result } = renderHook(() => useBatteryStatus());
    await act(async () => {});

    expect(result.current).toEqual({
      isSupported: true,
      level: 72,
      charging: true,
      chargingTime: 1_800,
      // `Infinity` non è un tempo: diventa 0 (sconosciuto).
      dischargingTime: 0,
    });
  });

  it('segue levelchange e chargingchange senza reload', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.5;

    const { result } = renderHook(() => useBatteryStatus());
    await act(async () => {});
    expect(result.current.level).toBe(50);

    // Soglia dell'80%: la presa smart stacca la carica.
    act(() => {
      battery.level = 0.8;
      battery.charging = true;
      battery.dispatchEvent(new Event('levelchange'));
    });
    expect(result.current).toMatchObject({ level: 80, charging: true });

    // La presa interviene: la carica si ferma senza che il livello cambi.
    act(() => {
      battery.charging = false;
      battery.dispatchEvent(new Event('chargingchange'));
    });
    expect(result.current).toMatchObject({ level: 80, charging: false });
  });

  it('stacca tutti i listener allo smontaggio', async () => {
    const { battery } = installFakeBattery();

    const { unmount } = renderHook(() => useBatteryStatus());
    await act(async () => {});
    expect(battery.listenerCount('levelchange')).toBe(1);
    expect(battery.listenerCount('chargingchange')).toBe(1);

    unmount();

    expect(battery.listenerCount()).toBe(0);
    // Nessun aggiornamento di stato su un hook smontato.
    expect(() => battery.dispatchEvent(new Event('levelchange'))).not.toThrow();
  });

  it('degrada senza eccezioni quando la Battery API non esiste (Safari/iPadOS)', async () => {
    removeFakeBattery();

    const { result } = renderHook(() => useBatteryStatus());
    await act(async () => {});

    expect(result.current).toEqual({
      isSupported: false,
      level: 0,
      charging: false,
      chargingTime: 0,
      dischargingTime: 0,
    });
  });

  it('degrada anche quando il browser nega l’accesso alla batteria', async () => {
    installFakeBattery({ fail: true });

    const { result } = renderHook(() => useBatteryStatus());
    await act(async () => {});

    expect(result.current.isSupported).toBe(false);
  });

  it('non lascia listener se lo smontaggio avviene prima della risposta', async () => {
    const { battery } = installFakeBattery();

    const { unmount } = renderHook(() => useBatteryStatus());
    // Nessun `await`: la Promise di `getBattery` è ancora in volo.
    unmount();
    await act(async () => {});

    expect(battery.listenerCount()).toBe(0);
  });
});
