import type { FastifyBaseLogger } from 'fastify';

/**
 * Canale real-time del sistema di sicurezza.
 *
 * Il worker MQTT e le rotte REST pubblicano qui ogni cambiamento di stato:
 * armamento, disinserimento, nuovo allarme, acknowledgment, rientri. I tablet
 * kiosk sono connessi via SSE (`GET /api/security/events`), quindi l'overlay
 * compare anche se il pannello non ha una socket MQTT attiva o l'app è stata
 * appena ricaricata.
 *
 * Il bus è volutamente in-process e senza dipendenze: la stessa
 * `SecurityStateEvent` viene inoltrata al broker da `alarmManager` (payload
 * retained su `security/alarm_state`), così resta un'unica fonte di verità.
 */

export type SecurityEventKind =
  | 'armed'
  | 'disarmed'
  | 'triggered'
  | 'acknowledged'
  | 'resolved';

export interface SecurityStateEvent {
  /** Cosa è cambiato: il client invalida la query e rilegge la verità dal DB. */
  type: SecurityEventKind;
  /** ISO 8601, generato dal server: nessun orologio del client in mezzo. */
  at: string;
  eventId?: string;
  deviceId?: string;
  eventType?: string;
  /** Stato dell'impianto **dopo** la mutazione. */
  status: string;
  /** Numero di eventi ancora aperti, per un'invalidazione mirata. */
  activeCount: number;
}

export type SecurityStateListener = (event: SecurityStateEvent) => void;

export interface SecurityEventBus {
  publish(event: SecurityStateEvent): void;
  /** Registra un client SSE; restituisce il cleanup idempotente. */
  subscribe(listener: SecurityStateListener): () => void;
  /**
   * Collega la pubblicazione MQTT (retained). La chiama `alarmManager`
   * all'avvio: le rotte REST pubblicano sul bus anche senza broker configurato.
   */
  attachMqtt(publisher: (event: SecurityStateEvent) => void): void;
  close(): void;
}

export function createSecurityEventBus(log?: FastifyBaseLogger): SecurityEventBus {
  const listeners = new Set<SecurityStateListener>();
  let mqtt: ((event: SecurityStateEvent) => void) | null = null;
  let closed = false;

  return {
    publish(event) {
      if (closed) return;
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          // Un client SSE guasto (tablet in sospensione, socket chiusa a metà)
          // non deve impedire la notifica agli altri né il publish MQTT.
          log?.warn(
            `sicurezza: listener real-time fallito: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (!mqtt) return;
      try {
        mqtt(event);
      } catch (error) {
        log?.warn(
          `sicurezza: pubblicazione MQTT fallita: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attachMqtt(publisher) {
      mqtt = publisher;
    },
    close() {
      closed = true;
      mqtt = null;
      listeners.clear();
    },
  };
}


