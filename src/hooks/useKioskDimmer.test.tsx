import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useKioskDimmer } from '@/hooks/useKioskDimmer';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('il passare del tempo (e quindi i movimenti anti burn-in) non risveglia il dimmer', () => {
  const { result } = renderHook(() => useKioskDimmer({ timeoutMs: 1_000 }));

  act(() => {
    vi.advanceTimersByTime(1_500);
  });
  expect(result.current.isDimmed).toBe(true);
  expect(result.current.secondsToSleep).toBe(0);

  // Dieci minuti di timer: nessun evento utente, lo standby resta.
  act(() => {
    vi.advanceTimersByTime(600_000);
  });
  expect(result.current.isDimmed).toBe(true);

  // Il primo tocco rimuove l'overlay e resetta la traslazione (via `enabled`).
  act(() => {
    window.dispatchEvent(new Event('pointerdown', { cancelable: true }));
  });
  expect(result.current.isDimmed).toBe(false);
});

it('azzera il tick di inattività allo smontaggio', () => {
  const { unmount } = renderHook(() => useKioskDimmer({ timeoutMs: 1_000 }));

  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
