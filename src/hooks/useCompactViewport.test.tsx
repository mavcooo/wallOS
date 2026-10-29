import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMPACT_VIEWPORT_QUERY, useCompactViewport } from '@/hooks/useCompactViewport';

/** jsdom non implementa matchMedia: stub minimo con emissione manuale. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<(event: { matches: boolean; media: string }) => void>();
  const query = {
    matches: initial,
    media: COMPACT_VIEWPORT_QUERY,
    addEventListener: (_type: string, listener: (event: { matches: boolean; media: string }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean; media: string }) => void) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    query,
    emit(matches: boolean) {
      query.matches = matches;
      for (const listener of listeners) listener({ matches, media: COMPACT_VIEWPORT_QUERY });
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCompactViewport', () => {
  it('senza matchMedia resta in layout desktop invece di rompersi', () => {
    vi.stubGlobal('matchMedia', undefined);

    const { result } = renderHook(() => useCompactViewport());

    expect(result.current).toBe(false);
  });

  it('legge il viewport compatto già al primo render', () => {
    installMatchMedia(true);

    const { result } = renderHook(() => useCompactViewport());

    // Sincrono: la shell non mostra la rail laterale per un frame.
    expect(result.current).toBe(true);
  });

  it('segue la rotazione del tablet e il ridimensionamento della finestra', () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useCompactViewport());
    expect(result.current).toBe(false);

    act(() => media.emit(true));
    expect(result.current).toBe(true);

    act(() => media.emit(false));
    expect(result.current).toBe(false);
  });

  it('rimuove il listener allo smontaggio', () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useCompactViewport());
    expect(media.listenerCount()).toBe(1);

    unmount();

    expect(media.listenerCount()).toBe(0);
  });
});
