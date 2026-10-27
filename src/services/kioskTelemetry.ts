import type { PublishOptions } from '@/types/mqtt';

/**
 * Telemetria di salute del pannello verso l'ecosistema domotico locale.
 *
 * Il tablet è alimentato H24: tenere la batteria al 100% per mesi deforma le
 * celle. Il pannello pubblica quindi il proprio livello di carica e permette a
 * una **presa smart** (o a una regola di automazione di wallOS) di staccare
 * l'alimentatore all'80% e di riattaccarlo al 20%.
 *
 * Contratto, stabile perché lo consuma hardware esterno:
 *
 *   topic   `wallos/kiosk/<kiosk_id>/battery`   (sotto il base topic del broker)
 *   payload `{ "kioskId", "level", "charging", "timestamp" }`
 *   flag    QoS 1 + `retain: true` — l'ultimo valore resta sul broker, così la
 *           presa lo legge anche se il pannello è riavviato quando si connette
 *
 * Il topic è volutamente "relativo": `useMqtt` applica il base topic della
 * casa (`casa/wallos/kiosk/...`), come per tutti gli altri topic del pannello.
 */

export const KIOSK_TELEMETRY_PREFIX = 'wallos/kiosk';

/** Payload normalizzato pubblicato su `wallos/kiosk/<kiosk_id>/battery`. */
export interface BatteryTelemetryPayload {
  /** Id del pannello (`wallos_kiosk_id`), es. `tablet_ingresso`. */
  kioskId: string;
  /** Percentuale intera 0-100. */
  level: number;
  charging: boolean;
  /** Epoch in millisecondi del campione. */
  timestamp: number;
}

/** Topic della batteria di un pannello, senza base topic. */
export function kioskBatteryTopic(kioskId: string): string {
  return `${KIOSK_TELEMETRY_PREFIX}/${kioskId}/battery`;
}

/**
 * QoS 1 + retain: un telemetria ogni 60 s sopporta un ack perso, ma la presa
 * deve sempre trovare l'ultimo valore noto sul broker.
 */
export const BATTERY_TELEMETRY_PUBLISH: PublishOptions = { qos: 1, retain: true };

/** Payload del campione corrente: livello arrotondato e limitato a 0-100. */
export function batteryTelemetryPayload(
  kioskId: string,
  battery: { level: number; charging: boolean },
  at: number = Date.now(),
): BatteryTelemetryPayload {
  return {
    kioskId,
    level: Math.round(Math.min(100, Math.max(0, battery.level))),
    charging: battery.charging === true,
    timestamp: at,
  };
}

export function serializeBatteryTelemetry(payload: BatteryTelemetryPayload): string {
  return JSON.stringify(payload);
}

/**
 * Firma del campione usata per non ripubblicare due volte lo stesso stato
 * (es. montaggio del hook + primo CONNACK): l'ora del campione cambia sempre,
 * quindi il confronto ignora il timestamp di proposito.
 */
export function batteryTelemetrySignature(battery: {
  level: number;
  charging: boolean;
}): string {
  return `${Math.round(battery.level)}|${battery.charging === true ? 'charging' : 'discharging'}`;
}

/**
 * Fascia di protezione della batteria (20-80% di default): la UI colora la
 * barra e la regola di automazione usa le stesse soglie.
 */
export type BatteryBand = 'ok' | 'low' | 'high';

export function batteryBand(
  level: number,
  band: { protectMinPercent: number; protectMaxPercent: number } = {
    protectMinPercent: 20,
    protectMaxPercent: 80,
  },
): BatteryBand {
  if (level < band.protectMinPercent) return 'low';
  if (level > band.protectMaxPercent) return 'high';
  return 'ok';
}
