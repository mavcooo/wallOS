/**
 * Battery Status API finta per i test.
 *
 * jsdom non implementa `navigator.getBattery()` (e nemmeno Safari/iPadOS): i
 * test che devono esercitare il percorso "browser con API batteria" installano
 * questo finto manager, quelli che verificano il degrado la lasciano assente.
 */

export class FakeBattery extends EventTarget {
  charging = false;
  chargingTime = Number.POSITIVE_INFINITY;
  dischargingTime = Number.POSITIVE_INFINITY;
  /** 0-1 come nel DOM. */
  level = 0.5;

  /** Listener ancora registrati, per verificare la pulizia allo smontaggio. */
  private registered = new Map<string, Set<EventListenerOrEventListenerObject>>();

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (listener) {
      const set = this.registered.get(type) ?? new Set();
      set.add(listener);
      this.registered.set(type, set);
    }
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (listener) this.registered.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  listenerCount(type?: string): number {
    if (type) return this.registered.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.registered.values()) total += set.size;
    return total;
  }
}

export interface FakeBatteryHandle {
  battery: FakeBattery;
  getBattery: () => Promise<FakeBattery>;
}

/** Installa `navigator.getBattery`; `fail` simula il permesso negato. */
export function installFakeBattery(options?: { fail?: boolean }): FakeBatteryHandle {
  const battery = new FakeBattery();
  const getBattery = async (): Promise<FakeBattery> => {
    if (options?.fail) throw new DOMException('Battery access denied', 'NotAllowedError');
    return battery;
  };
  Object.defineProperty(navigator, 'getBattery', { configurable: true, value: getBattery });
  return { battery, getBattery };
}

/** Rimuove l'API: è lo stato di Safari/iPadOS e dei browser che non la espongono. */
export function removeFakeBattery(): void {
  delete (navigator as { getBattery?: unknown }).getBattery;
}
