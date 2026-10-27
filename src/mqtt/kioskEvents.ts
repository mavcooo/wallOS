/**
 * Evento di configurazione display pubblicato dal server su
 * `wallos/system/kiosk/<kiosk_id>/config_updated` **contestualmente** al `PUT`
 * su PostgreSQL.
 *
 * Il pendant lato server è `server/services/kioskEvents.ts`: i due payload
 * devono restare allineati (stesso `.env`, stesso base topic).
 *
 * Il messaggio è *retained*: un tablet che si riavvia mentre l'amministratore
 * cambia il timeout del dimmer riceve comunque l'ultima configurazione appena
 * si riconnette, senza aspettare un altro salvataggio.
 */

import type { KioskDisplay } from '@/types/kiosk';

export const KIOSK_TOPIC_ROOT = 'wallos/system/kiosk';
export const KIOSK_CONFIG_UPDATED = 'config_updated';

/** Filtro sottoscritto una volta sola: vale per qualunque display. */
export const KIOSK_CONFIG_WILDCARD = `${KIOSK_TOPIC_ROOT}/+/${KIOSK_CONFIG_UPDATED}`;

/** Topic del singolo display, relativo a `MQTT_BASE_TOPIC`. */
export function kioskConfigTopic(id: string): string {
  return `${KIOSK_TOPIC_ROOT}/${id}/${KIOSK_CONFIG_UPDATED}`;
}

/**
 * Vero se il topic (già senza base topic) è una notifica di configurazione.
 * Il controllo è una `startsWith` perché viene eseguita su **ogni** messaggio
 * MQTT: nessun `JSON.parse` per la telemetria dei device.
 */
export function isKioskConfigTopic(localTopic: string): boolean {
  return localTopic.startsWith(`${KIOSK_TOPIC_ROOT}/`) && localTopic.endsWith(`/${KIOSK_CONFIG_UPDATED}`);
}

/** `wallos/system/kiosk/<id>/config_updated` → `<id>`. */
export function kioskIdFromTopic(localTopic: string): string | null {
  if (!isKioskConfigTopic(localTopic)) return null;
  const middle = localTopic.slice(KIOSK_TOPIC_ROOT.length + 1, -1 * (`/${KIOSK_CONFIG_UPDATED}`.length));
  return middle.length > 0 && !middle.includes('/') ? middle : null;
}

export interface KioskConfigEvent {
  id: string;
  config: KioskDisplay;
}

/**
 * Payload malformato = evento ignorato (nessun toast, nessuna preferenza
 * applicata): una configurazione a metà sarebbe peggio di quella vecchia.
 */
export function parseKioskConfig(localTopic: string, payload: string): KioskConfigEvent | null {
  const id = kioskIdFromTopic(localTopic);
  if (!id) return null;

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const record = data as Record<string, unknown>;
  const config = record.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;

  const display = config as Record<string, unknown>;
  // Il server manda sempre il DTO completo: se manca l'id non è una nostra
  // notifica e non va applicata.
  if (display.id !== id) return null;

  return { id, config: display as unknown as KioskDisplay };
}

type Listener = (event: KioskConfigEvent) => void;

/**
 * Bus in-memory tra `useMqtt` (unico possessore della socket) e
 * `useKioskSync` (unico che applica le preferenze): il hook resta
 * indipendente dal ciclo di vita della connessione e testabile da solo.
 */
const listeners = new Set<Listener>();

export function onKioskConfig(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitKioskConfig(event: KioskConfigEvent): void {
  for (const listener of listeners) listener(event);
}
