/** Tipi di dominio per trasporto MQTT, configurazione broker e telemetria di connessione. */

/**
 * Stato pubblicato su un topic LWT/availability.
 * Non esiste un "unknown" sul filo: l'assenza di payload viene scartata dal
 * parser e lascia intatta la riga realtime.
 */
export type MqttAvailabilityState = 'online' | 'offline';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  /**
   * Socket "half-open": la TCP non ha emesso FIN/RST ma il broker non
   * risponde più a nessun pacchetto applicativo (watchdog 90 s scattato).
   */
  | 'stale'
  | 'offline'
  | 'error';

export type MqttProtocol = 'ws' | 'wss';

export interface BrokerSettings {
  /** Host o IP del broker in LAN, es. `192.168.1.10`. */
  host: string;
  /** Porta del listener WebSocket (default 9001, TLS 9002). */
  port: number;
  protocol: MqttProtocol;
  /** Path del WebSocket, es. `/mqtt`. */
  path: string;
  clientId: string;
  /** Secondi. */
  keepAlive: number;
  username: string;
  password: string;
  /** Prefisso opzionale applicato ai topic (multi-tenant / ambiente di test). */
  baseTopic: string;
  cleanSession: boolean;
  /** Se true non apre socket: alimenta la UI con un simulatore locale. */
  demoMode: boolean;
}

export interface ConnectionMetrics {
  status: ConnectionStatus;
  /** RTT misurato sui pacchetti PINGREQ/PINGRESP del broker. */
  latencyMs: number | null;
  reconnectAttempts: number;
  /** Timestamp epoch dell'ultima connessione riuscita. */
  connectedAt: number | null;
  /**
   * Epoch ms dell'ultimo pacchetto realmente ricevuto (pong, echo, qualsiasi
   * messaggio valido). È la base del watchdog anti-freeze: se resta fermo
   * mentre `status === 'connected'`, il socket è zombie.
   */
  lastNetworkActivityAt: number | null;
  /** Epoch ms in cui il watchdog ha dichiarato la socket congelata. */
  frozenSince: number | null;
  lastError: string | null;
  messagesIn: number;
  messagesOut: number;
}

export type RawDirection = 'in' | 'out' | 'system';

export interface RawMqttMessage {
  id: string;
  direction: RawDirection;
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  at: number;
}

export interface PublishOptions {
  qos?: 0 | 1;
  retain?: boolean;
}

/** Interfaccia minima che l'app richiede al client MQTT (utile per i test). */
export interface MqttTransport {
  publish(topic: string, payload: string, options?: PublishOptions): void;
  end(): void;
}
