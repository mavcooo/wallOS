import type { FastifyInstance } from 'fastify';

import type { Database } from '../db.js';
import { requireAuth } from '../session.js';
import type { TopologyEventBus } from '../services/topologyEvents.js';
import type { AuthConfig } from '../types.js';

export interface TopologyEventsDeps {
  db: Database;
  config: AuthConfig;
  events: TopologyEventBus;
}

/** Commento SSE periodico: tiene vivo il flusso e fa rilevare i disconnect. */
const HEARTBEAT_MS = 25_000;

/**
 * Ripiego Server-Sent Events della sincronizzazione topologia.
 *
 * È il canale che usano i client quando la socket MQTT non è disponibile (broker
 * in manutenzione, porta 9001 bloccata): stesso payload di
 * `wallos/system/topology_changed`, stessa autenticazione delle altre rotte.
 * Il browser riconnette da solo (`retry: 3000`), quindi non serve codice di
 * ripresa lato client.
 */
export function registerTopologyEventRoutes(app: FastifyInstance, deps: TopologyEventsDeps): void {
  const preHandler = requireAuth(deps);
  /** Cleanup dei flussi aperti: chiusura del server → nessun socket orfano. */
  const clients = new Set<() => void>();

  app.get('/api/topology/events', { preHandler }, (_request, reply) => {
    const raw = reply.raw;
    // Fastify non deve gestire questa risposta: il flusso resta aperto.
    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Niente buffering lato reverse proxy: l'evento deve arrivare istantaneo.
      'X-Accel-Buffering': 'no',
    });
    // Intervallo di riconnessione suggerito al browser (ms).
    raw.write('retry: 3000\n\n');

    const unsubscribe = deps.events.subscribe((event) => {
      write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);

    function write(chunk: string): void {
      if (!clients.has(dispose)) return;
      try {
        raw.write(chunk);
      } catch {
        // Socket chiusa dal lato client senza evento `close`: ripulisci qui.
        dispose();
      }
    }

    function dispose(): void {
      if (!clients.delete(dispose)) return;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        raw.end();
      } catch {
        /* socket già chiusa */
      }
    }

    clients.add(dispose);
    raw.on('close', dispose);
  });

  app.addHook('onClose', async () => {
    for (const dispose of [...clients]) dispose();
  });
}
