import { parseTopology, type Topology } from './topologyApi';

/**
 * Ultima topologia ricevuta dal gateway, salvata sul dispositivo.
 *
 * Serve solo all'avvio offline: se il backend non risponde, il pannello può
 * mostrare la casa conosciuta invece di uno schermo d'errore. Lo stato runtime
 * dei device non è autorevole e verrà rinfrescato dal broker appena torna la
 * connessione.
 */
export const TOPOLOGY_CACHE_KEY = 'domus.topology.cache';

/** Oltre questa età la cache è considerata troppo vecchia per essere usata. */
export const TOPOLOGY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface TopologyCacheEntry {
  savedAt: number;
  topology: Topology;
}

export function saveTopologyCache(topology: Topology, now = Date.now()): TopologyCacheEntry {
  const entry: TopologyCacheEntry = { savedAt: now, topology };
  try {
    globalThis.localStorage?.setItem(TOPOLOGY_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage pieno o disabilitato: la cache è un'ottimizzazione, non un
    // requisito. La UI funziona lo stesso con la topologia appena ricevuta.
  }
  return entry;
}

export function readTopologyCache(now = Date.now()): TopologyCacheEntry | null {
  try {
    const raw = globalThis.localStorage?.getItem(TOPOLOGY_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { savedAt?: unknown; topology?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null;
    if (now - parsed.savedAt > TOPOLOGY_CACHE_MAX_AGE_MS) return null;

    return { savedAt: parsed.savedAt, topology: parseTopology(parsed.topology) };
  } catch {
    return null;
  }
}

export function clearTopologyCache(): void {
  try {
    globalThis.localStorage?.removeItem(TOPOLOGY_CACHE_KEY);
  } catch {
    // Nessuna cache da cancellare.
  }
}
