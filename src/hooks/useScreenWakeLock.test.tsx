import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useScreenWakeLock } from '@/hooks/useScreenWakeLock';

/**
 * Sentinel finto conforme a `WakeLockSentinel`: EventTarget + `released` +
 * `release()`. Gli handler registrati dall'hook restano tracciabili per
 * verificare la rimozione dei listener allo smontaggio.
 */
class FakeSentinel extends EventTarget {
  released = false;
  releaseCalls = 0;
  /** Conta i listener `release` ancora registrati sull'oggetto. */
  private listeners = new Set<EventListener>();

  override addEventListener(type: string, listener: EventListener | null): void {
    if (type === 'release' && listener) this.listeners.add(listener);
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: EventListener | null): void {
    if (type === 'release' && listener) this.listeners.delete(listener);
    super.removeEventListener(type, listener);
  }

  listenerCount(type: string): number {
    return type === 'release' ? this.listeners.size : 0;
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

/** Stato della `document.visibilityState` di jsdom, riscrivibile nei test. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function installWakeLock(options?: { fail?: boolean }) {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async () => {
    if (options?.fail) throw new DOMException('Permission denied', 'NotAllowedError');
    const sentinel = new FakeSentinel();
    sentinels.push(sentinel);
    return sentinel;
  });
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: { request },
  });
  return { request, sentinels };
}

function removeWakeLock(): void {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
}

beforeEach(() => {
  setVisibility('visible');
});

afterEach(() => {
  removeWakeLock();
  setVisibility('visible');
  vi.restoreAllMocks();
});

describe('useScreenWakeLock', () => {
  it('segnala il supporto e acquista il sentinel al montaggio', async () => {
    const { request, sentinels } = installWakeLock();

    const { result } = renderHook(() => useScreenWakeLock());

    expect(result.current.isSupported).toBe(true);
    await act(async () => {});
    expect(request).toHaveBeenCalledWith('screen');
    expect(result.current.isActive).toBe(true);
    expect(result.current.error).toBeNull();
    expect(sentinels[0]?.released).toBe(false);
  });

  it('riacquisisce il sentinel quando il documento torna visibile', async () => {
    const { request, sentinels } = installWakeLock();

    const { result } = renderHook(() => useScreenWakeLock());
    await act(async () => {});
    expect(result.current.isActive).toBe(true);

    // Il browser perde la visibilità: rilascia il sentinel da solo.
    await act(async () => {
      await sentinels[0]?.release();
      setVisibility('hidden');
    });
    expect(result.current.isActive).toBe(false);

    // Rientra in `visible`: l'hook deve richiedere un nuovo sentinel.
    await act(async () => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.isActive).toBe(true);
    expect(sentinels).toHaveLength(2);
  });

  it('releaseWakeLock ferma la riacquisizione automatica', async () => {
    const { request } = installWakeLock();

    const { result } = renderHook(() => useScreenWakeLock());
    await act(async () => {});

    await act(async () => {
      await result.current.releaseWakeLock();
    });
    expect(result.current.isActive).toBe(false);

    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Solo la richiesta iniziale: nessuna riacquisizione dopo il rilascio esplicito.
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.isActive).toBe(false);

    // Richiesta manuale: torna attivo.
    await act(async () => {
      await result.current.requestWakeLock();
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.isActive).toBe(true);
  });

  it('rilascia il sentinel e rimuove i listener allo smontaggio', async () => {
    const { sentinels } = installWakeLock();

    const { result, unmount } = renderHook(() => useScreenWakeLock());
    await act(async () => {});
    expect(result.current.isActive).toBe(true);
    const sentinel = sentinels[0];

    unmount();

    // Il sentinel viene rilasciato e il listener `release` staccato.
    expect(sentinel?.released).toBe(true);
    expect(sentinel?.releaseCalls).toBe(1);
    expect(sentinels[0]?.listenerCount('release')).toBe(0);

    // Nessun listener fantasma sul documento: il dispatch non deve più
    // toccare lo stato di un hook smontato.
    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
  });

  it("raccoglie l'errore quando la richiesta viene negata", async () => {
    installWakeLock({ fail: true });

    const { result } = renderHook(() => useScreenWakeLock());
    await act(async () => {});

    expect(result.current.isActive).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain('Permission denied');
  });

  it('è un no-op quando il browser non supporta la API', async () => {
    removeWakeLock();

    const { result } = renderHook(() => useScreenWakeLock());
    await act(async () => {});

    expect(result.current.isSupported).toBe(false);
    expect(result.current.isActive).toBe(false);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.requestWakeLock();
      await result.current.releaseWakeLock();
    });
    expect(result.current.isActive).toBe(false);
  });
});