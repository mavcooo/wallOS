import { TOPOLOGY_SYNC_DEFAULTS } from '@/config/app.config';
import type { TopologySyncSettings } from '@/types/topologySync';

export const TOPOLOGY_SYNC_LIMITS = {
  /** 0 = nessun ritardo: gli eventi dello stesso batch confluiscono comunque. */
  minDebounceMs: 0,
  /** Oltre il secondo non è più "tempo reale": resta un tetto di sicurezza. */
  maxDebounceMs: 2_000,
} as const;

/** Converte la configurazione richiesta in un valore valido e supportato. */
export function normalizeTopologySyncSettings(
  patch?: Partial<TopologySyncSettings>,
): TopologySyncSettings {
  const requested =
    typeof patch?.debounceMs === 'number' && Number.isFinite(patch.debounceMs)
      ? patch.debounceMs
      : TOPOLOGY_SYNC_DEFAULTS.debounceMs;

  return {
    debounceMs: Math.min(
      TOPOLOGY_SYNC_LIMITS.maxDebounceMs,
      Math.max(TOPOLOGY_SYNC_LIMITS.minDebounceMs, Math.round(requested)),
    ),
  };
}
