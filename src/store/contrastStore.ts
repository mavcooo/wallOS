import { create } from 'zustand';

import {
  AMBIENT_LUX_THRESHOLD,
  applyContrastAttribute,
  persistContrastPreference,
  readContrastPreference,
  systemPrefersHighContrast,
  type ContrastPreference,
} from '@/lib/contrast';

/** Perché la modalità è (o non è) attiva: mostrato nelle impostazioni. */
export type ContrastReason = 'manual' | 'system' | 'ambient';

interface ContrastState {
  /** Preferenza dell'utente, persistita in localStorage. */
  preference: ContrastPreference;
  /** `prefers-contrast: more` letto da `matchMedia`. */
  systemHighContrast: boolean;
  /** Ultima lettura del sensore di luce ambientale, in lux. */
  ambientLux: number | null;
  /** true se il browser espone `AmbientLightSensor` e il permesso è stato dato. */
  ambientSupported: boolean;
  setPreference(preference: ContrastPreference): void;
  toggle(): void;
  setSystemHighContrast(value: boolean): void;
  setAmbientLux(lux: number | null): void;
  setAmbientSupported(value: boolean): void;
}

type ContrastFacts = Pick<
  ContrastState,
  'preference' | 'systemHighContrast' | 'ambientLux'
>;

/**
 * Risolve lo stato effettivo: la scelta manuale vince sempre, poi la luce
 * ambientale oltre soglia, infine il sistema operativo.
 */
export function resolveContrast(state: ContrastFacts): {
  enabled: boolean;
  reason: ContrastReason;
} {
  if (state.preference === 'on') return { enabled: true, reason: 'manual' };
  if (state.preference === 'off') return { enabled: false, reason: 'manual' };
  if (state.ambientLux !== null && state.ambientLux >= AMBIENT_LUX_THRESHOLD) {
    return { enabled: true, reason: 'ambient' };
  }
  if (state.systemHighContrast) return { enabled: true, reason: 'system' };
  return { enabled: false, reason: 'manual' };
}

export const useContrastStore = create<ContrastState>()((set, get) => ({
  preference: typeof window === 'undefined' ? 'auto' : readContrastPreference(),
  systemHighContrast: typeof window === 'undefined' ? false : systemPrefersHighContrast(),
  ambientLux: null,
  ambientSupported: false,

  setPreference(preference) {
    persistContrastPreference(preference);
    set({ preference });
  },

  toggle() {
    // Il toggle esplicito esce dalla modalità automatica: quello che l'utente
    // vede in quel momento viene rovesciato e resta tale.
    get().setPreference(resolveContrast(get()).enabled ? 'off' : 'on');
  },

  setSystemHighContrast(systemHighContrast) {
    set({ systemHighContrast });
  },

  setAmbientLux(ambientLux) {
    set({ ambientLux });
  },

  setAmbientSupported(ambientSupported) {
    set({ ambientSupported });
  },
}));

/**
 * Applica subito il tema salvato: il primo paint del kiosk è già corretto,
 * senza un lampo di interfaccia a basso contrasto all'avvio.
 */
applyContrastAttribute(resolveContrast(useContrastStore.getState()).enabled);
