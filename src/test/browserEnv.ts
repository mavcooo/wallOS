/**
 * Aiuti per i test in ambiente `jsdom`: `window`, `localStorage` e i timer
 * arrivano dal DOM simulato, quindi non serve più ricostruirli a mano.
 */

/**
 * `localStorage` e `sessionStorage` sono condivisi fra i test dello stesso file
 * (un ambiente jsdom per file): vanno azzerati prima di ogni caso, altrimenti
 * il persist di zustand eredita lo stato del test precedente.
 */
export function resetBrowserStorage(): void {
  window.localStorage.clear();
  window.sessionStorage.clear();
}
