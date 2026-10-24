import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { usePerformanceMode } from '@/hooks/usePerformanceMode';
import { readPersistedPerformanceMode } from '@/lib/performance';
import { useHomeStore } from '@/store/homeStore';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.performanceMode;
  useHomeStore.setState((state) => ({
    ui: { ...state.ui, performanceMode: false },
  }));
});

describe('usePerformanceMode', () => {
  it('applica l’attributo su <html> e persiste la scelta', () => {
    const { result } = renderHook(() => usePerformanceMode());

    expect(document.documentElement.dataset.performanceMode).toBeUndefined();

    act(() => result.current.setEnabled(true));

    expect(document.documentElement.dataset.performanceMode).toBe('true');
    expect(useHomeStore.getState().ui.performanceMode).toBe(true);
    expect(readPersistedPerformanceMode()).toBe(true);

    act(() => result.current.toggle());

    expect(document.documentElement.dataset.performanceMode).toBeUndefined();
    expect(useHomeStore.getState().ui.performanceMode).toBe(false);
    expect(readPersistedPerformanceMode()).toBe(false);
  });

  it('riflette lo stato idratato e allinea il DOM al primo render', () => {
    localStorage.setItem(
      'domus-kiosk-store',
      JSON.stringify({ state: { ui: { performanceMode: true } }, version: 5 }),
    );
    expect(readPersistedPerformanceMode()).toBe(true);

    // Il persist di zustand idrata in modo sincrono: il hook deve riflettere
    // subito il valore salvato, senza un toggle dell’utente.
    useHomeStore.setState((state) => ({
      ui: { ...state.ui, performanceMode: true },
    }));

    const { result } = renderHook(() => usePerformanceMode());

    expect(result.current.enabled).toBe(true);
    expect(document.documentElement.dataset.performanceMode).toBe('true');
  });

  it('ignora un persist corrotto', () => {
    localStorage.setItem('domus-kiosk-store', '{non-json');

    expect(readPersistedPerformanceMode()).toBe(false);
  });
});
