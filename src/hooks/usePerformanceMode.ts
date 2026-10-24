import { useCallback, useEffect } from 'react';

import { applyPerformanceMode } from '@/lib/performance';
import { useHomeStore } from '@/store/homeStore';

export interface PerformanceModeState {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  toggle(): void;
}

/**
 * Modalità globale a basse prestazioni:
 * - persiste in localStorage dentro il persist dello store;
 * - scrive `<html data-performance-mode>` per gli override CSS (blur, ombre,
 *   gradienti e micro-animazioni);
 * - il setter applica l'attributo in modo sincrono, senza aspettare il render.
 */
export function usePerformanceMode(): PerformanceModeState {
  const enabled = useHomeStore((state) => state.ui.performanceMode);
  const setPerformanceMode = useHomeStore((state) => state.setPerformanceMode);

  const setEnabled = useCallback(
    (next: boolean) => {
      applyPerformanceMode(next);
      setPerformanceMode(next);
    },
    [setPerformanceMode],
  );

  const toggle = useCallback(() => setEnabled(!useHomeStore.getState().ui.performanceMode), [
    setEnabled,
  ]);

  // Copre l'idratazione, il cambio da un'altra scheda e i test che scrivono
  // direttamente nello store.
  useEffect(() => {
    applyPerformanceMode(enabled);
  }, [enabled]);

  return { enabled, setEnabled, toggle };
}
