/**
 * Modalità alto contrasto / leggibilità al sole.
 *
 * Questo modulo contiene solo funzioni pure e accessi difensivi alle API del
 * browser: lo stato vive nello store Zustand (`@/store/contrastStore`) e il
 * ciclo di vita nel hook `@/hooks/useHighContrast`.
 */

/**
 * `auto` segue il sistema operativo e, se disponibile, il sensore di luce.
 * `on`/`off` sono scelte esplicite dell'utente e vincono su tutto.
 */
export type ContrastPreference = 'auto' | 'on' | 'off';

/** Chiave localStorage: la scelta sopravvive al riavvio del tablet kiosk. */
export const CONTRAST_STORAGE_KEY = 'domus.contrast';

/**
 * Soglia di luce ambientale oltre la quale la modalità automatica si attiva.
 * 1000 lux corrisponde a un ambiente luminoso con luce indiretta o a un
 * pannello esposto vicino a una finestra.
 */
export const AMBIENT_LUX_THRESHOLD = 1000;

export function isContrastPreference(value: string | null | undefined): value is ContrastPreference {
  return value === 'auto' || value === 'on' || value === 'off';
}

/** Preferenza salvata sul dispositivo; `auto` è il default di fabbrica. */
export function readContrastPreference(): ContrastPreference {
  try {
    const stored = globalThis.localStorage?.getItem(CONTRAST_STORAGE_KEY);
    return isContrastPreference(stored) ? stored : 'auto';
  } catch {
    // Storage disabilitato (Safari privato, policy kiosk): si resta su auto.
    return 'auto';
  }
}

export function persistContrastPreference(preference: ContrastPreference): void {
  try {
    globalThis.localStorage?.setItem(CONTRAST_STORAGE_KEY, preference);
  } catch {
    // Nessuna persistenza: la modalità resta attiva per la sessione corrente.
  }
}

/** `prefers-contrast: more` dichiarato dal sistema operativo del tablet. */
export function systemPrefersHighContrast(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-contrast: more)').matches;
  } catch {
    return false;
  }
}

/**
 * Applica il tema a `<html data-contrast>`. Chiamata sia all'avvio (prima del
 * primo paint, così non c'è flash) sia a ogni cambio di stato.
 */
export function applyContrastAttribute(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.contrast = enabled ? 'high' : 'normal';
}
