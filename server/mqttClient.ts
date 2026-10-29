import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';

import type { MqttEventsConfig } from './types.js';

/**
 * Collegamento MQTT persistente del server (listener TCP del broker).
 *
 * Il browser ha la sua socket WebSocket (`src/mqtt/MqttProvider.tsx`); il
 * backend ne ha bisogno per due cose che un tablet in standby non può fare:
 * ascoltare i cambi di stato dei sensori e pubblicare i comandi delle
 * automazioni. Questo modulo è l'unico punto di connessione: sottoscrizioni
 * riallineate a ogni riconnessione, dispatch con isolamento degli errori,
 * publish QoS 1.
 *
 * I topic sono trattati come **relativi** a `MQTT_BASE_TOPIC`, esattamente
 * come i topic dei device nel database e nel pannello: il prefisso viene
 * aggiunto in uscita e tolto in entrata, così una regola si scrive
 * `stat/sensore_soggiorno/MOTION` e non deve conoscere il tenant.
 */

export interface MqttLinkOptions {
  /** Identificativo del client sul broker (unico per processo/istanza). */
  clientId: string;
  log?: FastifyBaseLogger;
}

export interface MqttLink {
  /** `false` quando `MQTT_HOST`/`MQTT_SERVER_URL` non sono configurati. */
  readonly enabled: boolean;
  /**
   * Pubblica su un topic relativo; `false` se il broker non è configurato.
   * `retain` conserva l'ultimo valore sul broker: lo stato di allarme resta
   * leggibile a un client che si collega dopo un blackout.
   */
  publish(topic: string, payload: string, options?: { retain?: boolean }): boolean;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  /** Ascoltatore dei messaggi: riceve topic relativo e payload testuale. */
  onMessage(handler: (topic: string, payload: string) => void): void;
  close(): Promise<void>;
}

/** Prefisso del tenant, normalizzato senza slash iniziali/finali. */
function basePrefix(baseTopic: string): string {
  return baseTopic.trim().replace(/^\/+|\/+$/g, '');
}

/** Topic relativo → topic assoluto sul broker (`base/topic`). */
export function absoluteTopic(baseTopic: string, topic: string): string {
  const base = basePrefix(baseTopic);
  const relative = topic.trim().replace(/^\/+/, '');
  return base ? `${base}/${relative}` : relative;
}

/** Topic assoluto → topic relativo (`base/topic` → `topic`). */
export function relativeTopic(baseTopic: string, topic: string): string {
  const base = basePrefix(baseTopic);
  if (!base) return topic;
  return topic.startsWith(`${base}/`) ? topic.slice(base.length + 1) : topic;
}

export function createMqttLink(settings: MqttEventsConfig, options: MqttLinkOptions): MqttLink {
  const { log, clientId } = options;
  const handlers = new Set<(topic: string, payload: string) => void>();
  const subscriptions = new Set<string>();
  let closed = false;

  if (!settings.url) {
    log?.warn(
      'automazioni: MQTT_HOST/MQTT_SERVER_URL assenti, il motore resta in ascolto solo ' +
        'dei timer (cron e alba/tramonto) e non può pubblicare comandi',
    );
    return {
      enabled: false,
      publish: () => false,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      onMessage(handler) {
        handlers.add(handler);
      },
      close: () => Promise.resolve(),
    };
  }

  const socket: MqttClient = mqtt.connect(settings.url, {
    clientId,
    reconnectPeriod: 2_000,
    connectTimeout: 5_000,
    clean: true,
    protocolVersion: 4,
    ...(settings.username ? { username: settings.username } : {}),
    ...(settings.password ? { password: settings.password } : {}),
  });

  socket.on('error', (error) => {
    // Senza listener l'evento `error` farebbe terminare il processo.
    log?.warn(`automazioni: errore broker MQTT (${settings.url}): ${error.message}`);
  });

  // A ogni riconnessione la sessione riparte pulita (`clean: true`): le
  // sottoscrizioni vanno rifatte, altrimenti dopo un riavvio del broker il
  // motore resterebbe sordo pur sembrando connesso.
  socket.on('connect', () => {
    log?.info(`automazioni: connesso al broker ${settings.url}`);
    for (const topic of subscriptions) {
      socket.subscribe(absoluteTopic(settings.baseTopic, topic), { qos: 1 }, (error) => {
        if (error) {
          log?.warn(`automazioni: sottoscrizione ${topic} fallita: ${error.message}`);
        }
      });
    }
  });

  socket.on('message', (topic, payload) => {
    const relative = relativeTopic(settings.baseTopic, topic);
    const text = payload.toString('utf8');
    for (const handler of handlers) {
      try {
        handler(relative, text);
      } catch (error) {
        log?.warn(
          `automazioni: ascoltatore MQTT fallito su ${relative}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  });

  return {
    enabled: true,
    publish(topic, payload, options) {
      if (closed) return false;
      socket.publish(
        absoluteTopic(settings.baseTopic, topic),
        payload,
        { qos: 1, retain: options?.retain ?? false },
        (error) => {
          if (error) log?.warn(`automazioni: publish fallito su ${topic}: ${error.message}`);
        },
      );
      return true;
    },
    subscribe(topic) {
      const relative = topic.trim();
      if (relative.length === 0 || subscriptions.has(relative)) return;
      subscriptions.add(relative);
      if (closed) return;
      socket.subscribe(absoluteTopic(settings.baseTopic, relative), { qos: 1 }, (error) => {
        if (error) log?.warn(`automazioni: sottoscrizione ${relative} fallita: ${error.message}`);
      });
    },
    unsubscribe(topic) {
      const relative = topic.trim();
      if (!subscriptions.delete(relative) || closed) return;
      socket.unsubscribe(absoluteTopic(settings.baseTopic, relative), () => undefined);
    },
    onMessage(handler) {
      handlers.add(handler);
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      subscriptions.clear();
      handlers.clear();
      return new Promise<void>((resolve) => {
        socket.end(true, () => resolve());
      });
    },
  };
}
