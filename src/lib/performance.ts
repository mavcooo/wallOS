/**
 * Performance / Low-Power Mode per i pannelli kiosk con hardware modesto.
 *
 * Lo stato autoritativo è nello store Zustand (`ui.performanceMode`), ma la
 * classe arriva su `<html>` prima del primo paint tramite lo script inline in
 * `index.html`: così non c'è un frame con blur e ombre prima dell'idratazione.
 */

export const PERFORMANCE_MODE_ATTRIBUTE = 'performanceMode';
export const PERSIST_STORAGE_KEY = 'domus-kiosk-store';

function readPerformanceModeFromStorage(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(PERSIST_STORAGE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const state = (parsed as { state?: unknown }).state;
    if (typeof state !== 'object' || state === null) return false;
    const ui = (state as { ui?: unknown }).ui;
    if (typeof ui !== 'object' || ui === null) return false;
    return (ui as { performanceMode?: unknown }).performanceMode === true;
  } catch {
    // Storage assente o JSON corrotto: si resta sulla modalità normale.
    return false;
  }
}

/** Applica o rimuove l'attributo che guida tutti gli override CSS. */
export function applyPerformanceMode(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (enabled) root.dataset[PERFORMANCE_MODE_ATTRIBUTE] = 'true';
  else delete root.dataset[PERFORMANCE_MODE_ATTRIBUTE];
}

/** Valore salvato dal persist, utile per sincronizzare il primo render. */
export function readPersistedPerformanceMode(): boolean {
  return readPerformanceModeFromStorage();
}
