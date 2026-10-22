/** Tipi di dominio per trasporto MQTT, configurazione broker e telemetria di connessione. */

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
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
