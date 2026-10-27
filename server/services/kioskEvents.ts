import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';

import type { AuthConfig, KioskConfigEvent } from '../types.js';

/**
 * Topic di sincronizzazione real-time dei display, **relativo** a
 * `MQTT_BASE_TOPIC` esattamente come i topic dei device:
 *
 *   wallos/system/kiosk/<kiosk_id>/config_updated
 *
 * Il pannello ascolta il proprio id (`useKioskSync`), gli altri tablet della
 * casa ricevono il messaggio e lo scartano.
 */
export const KIOSK_CONFIG_UPDATED = 'config_updated';

/** Oggetto del path: `wallos/system/kiosk`. */
export const KIOSK_TOPIC_ROOT = 'wallos/system/kiosk';

export function kioskConfigTopic(baseTopic: string, id: string): string {
  const base = baseTopic.trim().replace(/^\/+|\/+$/g, '');
  const path = `${KIOSK_TOPIC_ROOT}/${id}/${KIOSK_CONFIG_UPDATED}`;
  return base ? `${base}/${path}` : path;
}

/**
 * Notifica le modifiche di configurazione a un pannello.
 *
 * - `retain: true`: un tablet che si riavvia (o che era offline durante la
 *   modifica) riceve subito l'ultima configurazione dal broker, senza aspettare
 *   che l'amministratore la risalvi;
 * - QoS 1: mqtt.js accoda il publish finché la socket non è pronta, quindi un
 *   broker momentaneamente giù non perde la notifica;
 * - `url: null` (nessun `MQTT_HOST`/`MQTT_SERVER_URL`): nessuna socket, il
 *   pannello applica comunque la configurazione all'avvio via REST.
 */
export interface KioskConfigPublisher {
  publish(event: KioskConfigEvent): void;
  close(): Promise<void>;
}

export function createKioskConfigPublisher(
  config: AuthConfig,
  log?: FastifyBaseLogger,
): KioskConfigPublisher {
  const settings = config.mqtt;
  let client: MqttClient | null = null;

  if (!settings.url) {
    log?.warn(
      'display: MQTT_HOST/MQTT_SERVER_URL assenti, la sincronizzazione real-time dei pannelli ' +
        'è disabilitata (le modifiche si applicano al prossimo avvio)',
    );
  } else {
    const options = {
      clientId: `wallos-kiosk-${process.pid}-${Math.random().toString(16).slice(2, 6)}`,
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
      log?.warn(`display: errore broker MQTT (${settings.url}): ${error.message}`);
    });
    log?.info(`display: sincronizzazione configurazione via ${settings.url}`);
  }

  let closed = false;

  return {
    publish(event) {
      if (closed || !client) return;
      const topic = kioskConfigTopic(settings.baseTopic, event.id);
      client.publish(topic, JSON.stringify(event), { qos: 1, retain: true }, (error) => {
        if (error) log?.warn(`display: publish fallito su ${topic}: ${error.message}`);
      });
    },
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
