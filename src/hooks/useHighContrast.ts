import { useEffect } from 'react';

import { applyContrastAttribute, type ContrastPreference } from '@/lib/contrast';
import {
  resolveContrast,
  useContrastStore,
  type ContrastReason,
} from '@/store/contrastStore';

/** Forma minima della Ambient Light Sensor API, assente nei tipi DOM. */
interface AmbientLightSensorInstance {
  illuminance: number;
  start(): void;
  stop(): void;
  addEventListener(type: 'reading', listener: () => void): void;
  removeEventListener(type: 'reading', listener: () => void): void;
}

type AmbientLightSensorConstructor = new (options?: {
  frequency?: number;
}) => AmbientLightSensorInstance;

function ambientSensorConstructor(): AmbientLightSensorConstructor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (
    window as Window & { AmbientLightSensor?: AmbientLightSensorConstructor }
  ).AmbientLightSensor;
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * Ascolta sistema e sensore di luce una sola volta per tutta l'app, anche se
 * il hook è montato da più componenti (header + impostazioni).
 */
function bindEnvironment(): () => void {
  const cleanups: Array<() => void> = [];
  const store = useContrastStore.getState();

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      const query = window.matchMedia('(prefers-contrast: more)');
      const sync = () => store.setSystemHighContrast(query.matches);
      sync();
      query.addEventListener('change', sync);
      cleanups.push(() => query.removeEventListener('change', sync));
    } catch {
      // matchMedia non disponibile: resta la preferenza salvata.
    }
  }

  const Sensor = ambientSensorConstructor();
  if (Sensor) {
    try {
      const sensor = new Sensor({ frequency: 2 });
      const onReading = () => {
        store.setAmbientLux(
          Number.isFinite(sensor.illuminance) ? sensor.illuminance : null,
        );
      };
      sensor.addEventListener('reading', onReading);
      sensor.start();
      store.setAmbientSupported(true);
      cleanups.push(() => {
        sensor.removeEventListener('reading', onReading);
        sensor.stop();
        useContrastStore.getState().setAmbientSupported(false);
        useContrastStore.getState().setAmbientLux(null);
      });
    } catch {
      // Permesso negato, sensore assente o browser non compatibile: degrade
      // silenzioso, l'attivazione manuale continua a funzionare.
      store.setAmbientSupported(false);
    }
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/** Montaggi attivi del hook: il binding ambientale resta singolo. */
let mounts = 0;
let teardown: (() => void) | null = null;

export interface HighContrastState {
  /** Stato effettivo applicato al documento. */
  enabled: boolean;
  preference: ContrastPreference;
  /** Da dove arriva lo stato corrente: utile per spiegarlo a schermo. */
  reason: ContrastReason;
  systemHighContrast: boolean;
  ambientLux: number | null;
  ambientSupported: boolean;
  setPreference(preference: ContrastPreference): void;
  toggle(): void;
}

/**
 * Stato e ciclo di vita della modalità alto contrasto:
 * - scrive `<html data-contrast>` a ogni cambio (i token CSS fanno il resto);
 * - segue `prefers-contrast: more`;
 * - usa `AmbientLightSensor` quando il tablet e il browser lo espongono.
 */
export function useHighContrast(): HighContrastState {
  const preference = useContrastStore((state) => state.preference);
  const systemHighContrast = useContrastStore((state) => state.systemHighContrast);
  const ambientLux = useContrastStore((state) => state.ambientLux);
  const ambientSupported = useContrastStore((state) => state.ambientSupported);
  const setPreference = useContrastStore((state) => state.setPreference);
  const toggle = useContrastStore((state) => state.toggle);

  const { enabled, reason } = resolveContrast({
    preference,
    systemHighContrast,
    ambientLux,
  });

  // L'attributo va applicato dopo ogni cambio, prima del paint successivo.
  useEffect(() => {
    applyContrastAttribute(enabled);
  }, [enabled]);

  useEffect(() => {
    if (mounts === 0) teardown = bindEnvironment();
    mounts += 1;
    return () => {
      mounts -= 1;
      if (mounts === 0) {
        teardown?.();
        teardown = null;
      }
    };
  }, []);

  return {
    enabled,
    preference,
    reason,
    systemHighContrast,
    ambientLux,
    ambientSupported,
    setPreference,
    toggle,
  };
}
