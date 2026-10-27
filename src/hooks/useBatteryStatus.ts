import { useEffect, useState } from 'react';

/**
 * Livello di carica e stato di alimentazione del pannello.
 *
 * Usa la **Battery Status API** (`navigator.getBattery()`), che è non standard
 * e non esiste ovunque: su iPadOS/Safari (WebKit non la espone affatto) e sui
 * browser che la richiedono dietro un permesso negato. In quei casi l'hook
 * resta valido e silenzioso — `isSupported: false`, nessuna eccezione, nessun
 * blocco del rendering — e la diagnostica lo dichiara invece di mostrare uno
 * 0% che non esiste.
 *
 * Gli eventi `levelchange` e `chargingchange` (più i tempi stimati) aggiornano
 * lo stato in tempo reale: sono la base della telemetria MQTT che fa staccare
 * la presa all'80% e riattaccarla al 20%.
 */

/**
 * Sottoinsieme dell'oggetto restituito da `navigator.getBattery()`.
 *
 * Il tipo `BatteryManager` non è garantito nei lib DOM di tutte le versioni di
 * TypeScript, e i browser espongono solo queste proprietà: si dichiara qui la
 * forma minima che l'app usa (le letture sono di sola lettura).
 */
export interface BatteryManagerLike extends EventTarget {
  readonly charging: boolean;
  readonly chargingTime: number;
  readonly dischargingTime: number;
  /** 0-1 nel DOM, 0-100 in `BatteryState`. */
  readonly level: number;
}

type NavigatorWithBattery = Navigator & {
  getBattery?: () => Promise<BatteryManagerLike>;
};

export interface BatteryState {
  /** `false` quando il browser non espone la Battery Status API. */
  isSupported: boolean;
  /** 0-100. Vale 0 quando `isSupported` è `false`: la UI legge il badge. */
  level: number;
  charging: boolean;
  /** Secondi stimati, 0 quando il browser non li fornisce (`Infinity` incluso). */
  chargingTime: number;
  dischargingTime: number;
}

const UNSUPPORTED: BatteryState = {
  isSupported: false,
  level: 0,
  charging: false,
  chargingTime: 0,
  dischargingTime: 0,
};

/** Tutti gli eventi dell'API che cambiano ciò che il pannello pubblica o mostra. */
const BATTERY_EVENTS = [
  'levelchange',
  'chargingchange',
  'chargingtimechange',
  'dischargingtimechange',
] as const;

/** `Infinity` (carica completa o dato non disponibile) diventa 0. */
function normalizeSeconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function normalizeLevel(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value * 100))) : 0;
}

function snapshotOf(manager: BatteryManagerLike): BatteryState {
  return {
    isSupported: true,
    level: normalizeLevel(manager.level),
    charging: manager.charging === true,
    chargingTime: normalizeSeconds(manager.chargingTime),
    dischargingTime: normalizeSeconds(manager.dischargingTime),
  };
}

export function useBatteryStatus(): BatteryState {
  const [state, setState] = useState<BatteryState>(UNSUPPORTED);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const getBattery = (navigator as NavigatorWithBattery).getBattery;
    // Degrado trasparente: nessuna API, nessun errore, stato non supportato.
    if (typeof getBattery !== 'function') return;

    let active = true;
    let manager: BatteryManagerLike | null = null;
    const update = () => {
      if (active && manager) setState(snapshotOf(manager));
    };

    getBattery
      .call(navigator)
      .then((battery) => {
        // Lo smontaggio può avvenire mentre la Promise è in volo: nessun
        // listener lasciato sull'oggetto scartato.
        if (!active) return;
        manager = battery;
        for (const event of BATTERY_EVENTS) battery.addEventListener(event, update);
        update();
      })
      .catch(() => {
        // Permesso negato o API rimossa a runtime: resta non supportata.
      });

    return () => {
      active = false;
      const current = manager;
      manager = null;
      if (!current) return;
      for (const event of BATTERY_EVENTS) current.removeEventListener(event, update);
    };
  }, []);

  return state;
}
