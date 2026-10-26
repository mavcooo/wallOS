import { useEffect } from 'react';

import { hasAvailabilityTopic } from '@/lib/availability';
import { useHomeStore } from '@/store/homeStore';
import type { DeviceMetadata } from '@/types/device';

/**
 * Watchdog della disponibilità per i device senza LWT.
 *
 * I sensori Zigbee a batteria (temperatura, movimento, contatto) dormono in
 * profondità e pubblicano ogni 10–30 minuti: non hanno un Last Will utile,
 * perché un `offline` del broker arriverebbe con ore di ritardo o mai. Il
 * silenzio prolungato è quindi l'unico segnale affidabile.
 *
 * Un solo timer globale (non uno per device) controlla le righe in O(n) ogni
 * 30 s: a 30–60 device il costo è trascurabile e non tiene sveglio il kiosk.
 */

/** Silenzio oltre il quale un sensore senza LWT è considerato muto. */
export const DEFAULT_STALE_TIMEOUT_MS = 30 * 60 * 1_000;

/** Frequenza del controllo: abbastanza fitto per un kiosk, irrilevante in CPU. */
export const STALE_CHECK_INTERVAL_MS = 30 * 1_000;

/**
 * Timeout effettivo di un device.
 *
 * - un valore esplicito (`staleTimeoutMs`) vince sempre;
 * - i sensori senza LWT ricevono il default di 30 minuti;
 * - gli attuatori con LWT non ne hanno bisogno: il broker li dichiara.
 */
export function staleTimeoutFor(device: DeviceMetadata): number | null {
  if (device.staleTimeoutMs && device.staleTimeoutMs > 0) return device.staleTimeoutMs;
  if (device.kind === 'sensor' && !hasAvailabilityTopic(device)) {
    return DEFAULT_STALE_TIMEOUT_MS;
  }
  return null;
}

/**
 * Marca `stale` i device il cui ultimo payload è troppo vecchio.
 *
 * `lastUpdated` è l'ultimo payload valido; un device già `offline` da LWT non
 * viene toccato (il broker ha un'informazione più precisa del timer) e uno
 * `stale` si riarma al primo messaggio metrico.
 */
export function runAvailabilityWatchdog(
  devices: readonly DeviceMetadata[],
  now: number = Date.now(),
): string[] {
  const { deviceStates, setAvailability } = useHomeStore.getState();
  const marked: string[] = [];
  for (const device of devices) {
    const timeout = staleTimeoutFor(device);
    if (!timeout) continue;
    const row = deviceStates[device.id];
    if (!row || row.availability === 'offline' || !row.isAvailable) continue;
    if (now - row.lastUpdated <= timeout) continue;
    setAvailability(device.id, 'stale');
    marked.push(device.id);
  }
  return marked;
}

/** Monta il watchdog: un controllo immediato e poi un tick periodico. */
export function useAvailabilityWatchdog(devices: readonly DeviceMetadata[]): void {
  useEffect(() => {
    // Il controllo immediato copre gli snapshot ripristinati dal server con
    // un `lastSeen` già vecchio, senza aspettare il primo tick.
    runAvailabilityWatchdog(devices);
    const timer = window.setInterval(() => {
      runAvailabilityWatchdog(devices);
    }, STALE_CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [devices]);
}
