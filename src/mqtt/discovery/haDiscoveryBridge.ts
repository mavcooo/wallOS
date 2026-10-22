import { DISCOVERY } from '@/config/app.config';
import type { Device } from '@/types/device';

import { normalizeDiscovery, parseDiscoveryTopic } from './normalize';
import { parseDiscoveryPayload } from './types';

export interface HaDiscoveryBridgeOptions {
  /** Prefissi di discovery (default `DISCOVERY.prefixes`). */
  prefixes?: readonly string[];
  /** Finestra di debounce: il broker manda decine di retained in raffica. */
  flushDelayMs?: number;
  /** Device nuovo o aggiornato: lo store fa l'upsert, il client si sottoscrive. */
  onUpsert(device: Device): void;
  /** Entità ritirata (`payload` vuoto sul topic di config). */
  onRemove(entityId: string): void;
}

export interface HaDiscoveryBridge {
  /** `true` se il topic è un annuncio di discovery per i prefissi configurati. */
  matches(topic: string): boolean;
  /**
   * Gestisce un messaggio del broker: annuncio, aggiornamento o — con payload
   * vuoto, come da specifica — rimozione dell'entità.
   */
  handleMessage(topic: string, payload: string): void;
  /** Applica subito le modifiche in sospeso (usato allo smontaggio). */
  flush(): void;
  dispose(): void;
}

/**
 * Ponte fra il protocollo Home Assistant MQTT Discovery e il modello interno.
 *
 * Non tocca lo store direttamente: emette device normalizzati, così è testabile
 * senza MQTT e senza Zustand. Le registrazioni sono accorpate in una finestra
 * di debounce, perché all'avvio il broker consegna i config retained a raffica
 * e ogni upsert farà scattare nuove sottoscrizioni.
 */
export function createHaDiscoveryBridge(
  options: HaDiscoveryBridgeOptions,
): HaDiscoveryBridge {
  const prefixes = options.prefixes ?? DISCOVERY.prefixes;
  const flushDelayMs = options.flushDelayMs ?? DISCOVERY.flushDelayMs;
  /** `null` = rimozione in sospeso, `Device` = upsert. */
  const pending = new Map<string, Device | null>();
  let timer: number | null = null;

  const flush = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;

    const entries = [...pending.entries()];
    pending.clear();
    for (const [entityId, device] of entries) {
      if (device) options.onUpsert(device);
      else options.onRemove(entityId);
    }
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      flush();
    }, flushDelayMs);
  };

  return {
    matches(topic) {
      return parseDiscoveryTopic(topic, prefixes) !== null;
    },

    handleMessage(topic, payload) {
      const ref = parseDiscoveryTopic(topic, prefixes);
      if (!ref) return;

      if (!payload.trim()) {
        // Deletion: vale anche per componenti che non sappiamo mappare, così
        // un'entità già a store non resta orfana.
        pending.set(ref.entityId, null);
        schedule();
        return;
      }

      const config = parseDiscoveryPayload(payload);
      // Payload malformato: si tiene l'ultima configurazione valida conosciuta.
      if (!config) return;

      const normalized = normalizeDiscovery(ref, config);
      // Componente non supportato o annuncio inutilizzabile: nessun widget.
      if (!normalized) return;

      pending.set(normalized.entityId, normalized.device);
      schedule();
    },

    flush,
    dispose() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
