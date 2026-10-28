import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';

import type { AuthConfig } from '../types.js';

/**
 * Topic di sistema su cui il server annuncia le mutazioni di topologia.
 * Deve combaciare con `TOPOLOGY_CHANGED_TOPIC` del client: entrambi i lati
 * leggono `MQTT_BASE_TOPIC` dallo stesso `.env`, quindi il prefisso è uguale.
 */
export const TOPOLOGY_CHANGED_TOPIC = 'wallos/system/topology_changed';

/**
 * Entità che possono cambiare: `floor` copre il salvataggio della planimetria
 * (`PUT /api/floors/:id/layout`), che sposta stanze e marker in un colpo solo.
 */
export type TopologyEntity = 'floor' | 'room' | 'device' | 'scenario';

/** `created` / `updated` / `deleted` / `reordered`: finisce in `event`. */
export type TopologyChangeKind = 'created' | 'updated' | 'deleted' | 'reordered';

/**
 * Payload letto dal client (vedi `src/mqtt/topologyEvents.ts`).
 * `sourceClientId` è l'id del pannello che ha generato la mutazione: quel
 * client ha già invalidato la cache in locale e può ignorare il messaggio.
 */
export interface TopologyChangedEvent {
  event: string;
  entity: TopologyEntity;
  id: string;
  timestamp: number;
  sourceClientId?: string;
}

export type TopologyEventListener = (event: TopologyChangedEvent) => void;

export function topologyEventName(entity: TopologyEntity, kind: TopologyChangeKind): string {
  return `${entity}_${kind}`;
}

/**
 * Unico punto di pubblicazione delle mutazioni di topologia:
 *
 * - `subscribe` → client SSE connessi a `GET /api/topology/events` (canale di
 *   ripiego quando il broker non è raggiungibile, ma attivo sempre)
 * - `publish`   → notifica i subscriber **e**, se configurato, pubblica su MQTT
 *   per tutti i pannelli che mantengono la socket
 */
export interface TopologyEventBus {
  publish(event: TopologyChangedEvent): void;
  /** Registra un ascoltatore SSE; restituisce il cleanup idempotente. */
  subscribe(listener: TopologyEventListener): () => void;
  close(): Promise<void>;
}

function createFanOut(log?: FastifyBaseLogger) {
  const listeners = new Set<TopologyEventListener>();

  return {
    subscribe(listener: TopologyEventListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify(event: TopologyChangedEvent) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          // Un client SSE guasto non deve impedire gli altri né il publish MQTT.
          log?.warn(
            `eventi di topologia: listener fallito: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    },
  };
}

/** Topic assoluto da pubblicare: stessa normalizzazione di `withBaseTopic`. */
export function resolveTopologyTopic(baseTopic: string): string {
  const base = baseTopic.trim().replace(/^\/+|\/+$/g, '');
  return base ? `${base}/${TOPOLOGY_CHANGED_TOPIC}` : TOPOLOGY_CHANGED_TOPIC;
}

/**
 * Connessione persistente al broker locale (listener TCP, non il WebSocket del
 * browser) per notificare **tutti** i client a ogni commit su PostgreSQL.
 *
 * - `url: null` (nessuna variabile impostata) → niente socket: gli eventi
 *   raggiungono comunque i client SSE, che è il canale di ripiego
 * - QoS 1: mqtt.js accoda i publish finché la socket non è pronta, quindi un
 *   broker momentaneamente giù non perde l'evento (rilasciato a PUBACK)
 * - riconnessione automatica ogni 2 s finché il broker non risponde
 */
export function createTopologyEventBus(
  config: AuthConfig,
  log?: FastifyBaseLogger,
): TopologyEventBus {
  const settings = config.mqtt;
  const fanOut = createFanOut(log);

  let client: MqttClient | null = null;
  if (!settings.url) {
    log?.warn(
      'eventi di topologia: MQTT_HOST/MQTT_SERVER_URL assenti, pubblicazione MQTT disabilitata ' +
        '(i client ricevono gli eventi solo via SSE finché il broker non è configurato)',
    );
  } else {
    const options = {
      clientId: `wallos-server-${process.pid}-${Math.random().toString(16).slice(2, 6)}`,
      reconnectPeriod: 2_000,
      connectTimeout: 5_000,
      clean: true,
      protocolVersion: 4 as const,
      ...(settings.username ? { username: settings.username } : {}),
      ...(settings.password ? { password: settings.password } : {}),
    };

    client = mqtt.connect(settings.url, options);
    client.on('error', (error) => {
      // Senza listener l'evento `error` farebbe crashare il processo.
      log?.warn(`eventi di topologia: errore broker MQTT (${settings.url}): ${error.message}`);
    });
    log?.info(
      `eventi di topologia: pubblicazione su ${resolveTopologyTopic(settings.baseTopic)} via ${settings.url}`,
    );
  }

  const topic = resolveTopologyTopic(settings.baseTopic);
  let closed = false;

  return {
    publish(event) {
      // SSE prima di MQTT: il canale locale non dipende dal broker.
      fanOut.notify(event);
      if (closed || !client) return;
      client.publish(topic, JSON.stringify(event), { qos: 1 }, (error) => {
        if (error) {
          log?.warn(`eventi di topologia: publish fallito su ${topic}: ${error.message}`);
        }
      });
    },
    subscribe: fanOut.subscribe,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      if (!client) return Promise.resolve();
      const socket = client;
      client = null;
      return new Promise<void>((resolve) => {
        socket.end(true, () => resolve());
      });
    },
  };
}
