import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { loadConfig } from './config.js';
import { Database, shortVersion } from './db.js';
import { HttpError } from './http.js';
import type { MqttLink } from './mqttClient.js';
import { createAutomationEngine, type AutomationEngine } from './services/automationEngine.js';
import { registerAutomationRoutes } from './routes/automations.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerClimateRoutes } from './routes/climate.js';
import { registerDatabaseRoutes } from './routes/database.js';
import { registerFloorRoutes } from './routes/floors.js';
import { registerKioskRoutes } from './routes/kiosk.js';
import { registerTopologyRoutes } from './routes/topology.js';
import { registerTopologyEventRoutes } from './routes/topologyEvents.js';
import { registerUserRoutes } from './routes/users.js';
import {
  createKioskConfigPublisher,
  type KioskConfigPublisher,
} from './services/kioskEvents.js';
import {
  createTopologyEventBus,
  type TopologyEventBus,
} from './services/topologyEvents.js';
import {
  registerTelemetryIngestRoutes,
  registerTelemetryRoutes,
  registerTelemetrySummaryRoutes,
} from './routes/telemetry.js';
import { hashSecret, randomToken } from './security.js';
import { seedDatabase } from './seed.js';
import type { AuthConfig } from './types.js';

export interface BuildAppOptions {
  config?: AuthConfig;
  logger?: boolean;
  /** Database già costruito (test con PGlite); altrimenti pool da config. */
  db?: Database;
  /** Bus degli eventi di topologia: nei test si inietta un falso spia. */
  topologyEvents?: TopologyEventBus;
  /**
   * Collegamento MQTT del motore di automazioni. In produzione il motore lo
   * costruisce da sé in `start()` (chiamato solo da `server/index.ts`), mentre
   * nei test si inietta un falso per osservare i comandi pubblicati senza
   * aprire socket.
   */
  mqttLink?: MqttLink;
  /**
   * Notifica MQTT delle modifiche di configurazione dei display. In produzione
   * la costruisce `buildApp` dal `.env`; nei test si inietta un falso spia per
   * verificare il topic senza aprire socket.
   */
  kioskPublisher?: KioskConfigPublisher;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Database;
  /** Motore delle automazioni: `start()`/`stop()` li pilota `server/index.ts`. */
  automations: AutomationEngine;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Vero quando `Origin` coincide con l'`Host` della richiesta, cioè quando il
 * pannello chiama la propria stessa origine (anche via proxy Vite). È il caso
 * del tablet che apre `http://192.168.0.20:3000`: non è cross-site, quindi non
 * va elencato in `CORS_ORIGINS`, che resta per origini *diverse* (reverse
 * proxy, domini aggiuntivi). Il confronto Origin/Host è la difesa CSRF
 * standard e non si fida del solo header `Origin`.
 */
function isSameOriginRequest(request: FastifyRequest): boolean {
  const { origin, host } = request.headers;
  if (typeof origin !== 'string' || typeof host !== 'string' || origin === 'null') {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Crea l'istanza Fastify (usata anche dai test con `inject`).
 * L'unico punto in cui vengono toccati DB, policy e segreti è questo.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const db =
    options.db ??
    new Database({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      ssl: config.dbSsl,
      connectionTimeoutMillis: config.dbConnectTimeoutMs,
      idleTimeoutMillis: config.dbIdleTimeoutMs,
    });

  await db.init();
  // Seed demo solo se esplicitamente abilitato (`AUTO_SEED=true`), e comunque
  // `seedDatabase` scrive soltanto su database vuoto. Il default è spento:
  // riavvii e deploy non possono reintegrare stanze o dispositivi eliminati.
  // La CLI `npm run db:seed` resta la via per popolare un database di test.
  if (config.seed.autoSeed) {
    await seedDatabase(db, config, config.nodeEnv === 'test' ? { log: () => {} } : {});
  } else if (config.nodeEnv !== 'test') {
    console.log('[Seed] AUTO_SEED non attivo: nessun dato demo scritto al boot');
  }
  await db.purgeExpiredRefreshTokens();

  // Hash di confronto per il login: evita di distinguere via timing
  // "utente inesistente" da "password errata".
  const dummyPasswordHash = await hashSecret(randomToken(), config.bcryptRounds);

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
  });

  // DELETE e POST senza corpo non devono fallire solo perché il client invia
  // `Content-Type: application/json` (curl, alcuni SDK): corpo vuoto = oggetto
  // vuoto, mentre un JSON malformato resta un 400.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(new HttpError(400, 'INVALID_JSON', 'Corpo JSON non valido'), undefined);
      }
    },
  );

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Client-Id identifica il pannello che origina una mutazione: serve al
    // server per riecheggiarlo nell'evento e al client per non rifare il refetch.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id'],
    maxAge: 600,
  });

  // Difesa CSRF aggiuntiva rispetto a SameSite=Strict: le richieste che
  // modificano stato devono arrivare da un Origin esplicitamente consentito.
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return;
    if (!config.corsOrigins.includes(origin) && !isSameOriginRequest(request)) {
      throw new HttpError(
        403,
        'ORIGIN_NOT_ALLOWED',
        'Origin non consentita: aggiungi l’indirizzo del pannello a CORS_ORIGINS',
      );
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.headers) {
        for (const [name, value] of Object.entries(error.headers)) {
          reply.header(name, value);
        }
      }
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ?? {}),
      });
    }

    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: 'BAD_REQUEST',
        message: 'Richiesta non valida',
      });
    }

    request.log.error({ err: error }, 'richiesta non gestita');
    return reply.code(500).send({
      error: 'INTERNAL_ERROR',
      message: 'Errore interno del servizio di autenticazione',
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'NOT_FOUND', message: 'Endpoint non trovato' }),
  );

  // Health per il monitoraggio: una query reale sul DB, non solo il processo.
  // 200 quando il database risponde, 503 quando è irraggiungibile.
  // `db.health()` non lancia: l'errore arriva già come codice
  // (ECONNREFUSED, 28P01…) più la latenza misurata sul pool.
  app.get('/api/health', async (_request, reply) => {
    const health = await db.health();
    const latencyMs = health.latencyMs ?? 0;

    if (health.healthy) {
      return {
        status: 'ok',
        database: {
          status: 'up',
          version: health.server ? shortVersion(health.server.version) : '',
          latencyMs,
        },
      };
    }

    return reply.code(503).send({
      status: 'degraded',
      database: {
        status: 'down',
        // Codice PostgreSQL/Node (es. ECONNREFUSED): niente host o password.
        error: health.error ?? 'DATABASE_UNAVAILABLE',
        latencyMs,
      },
    });
  });

  const topologyEvents =
    options.topologyEvents ?? createTopologyEventBus(config, app.log);
  const kioskPublisher =
    options.kioskPublisher ?? createKioskConfigPublisher(config, app.log);

  // Motore di automazioni: qui si costruisce solo l'istanza (cache vuota, nessun
  // timer e nessuna socket MQTT). Il ciclo di vita lo avvia `server/index.ts`
  // con `start()`, così i test possono chiamare `tick()` e `handleMessage()`
  // senza processi in background.
  const automations = createAutomationEngine({
    db,
    config,
    log: app.log,
    ...(options.mqttLink ? { link: options.mqttLink } : {}),
  });

  registerAuthRoutes(app, { db, config, dummyPasswordHash });
  registerUserRoutes(app, { db, config });
  registerTopologyRoutes(app, { db, config, events: topologyEvents });
  // Ripiego SSE: i client la aprono solo quando la socket MQTT non è viva.
  registerTopologyEventRoutes(app, { db, config, events: topologyEvents });
  registerTelemetryRoutes(app, { db, config });
  registerTelemetrySummaryRoutes(app, { db, config });
  registerTelemetryIngestRoutes(app, { db, config });
  // Diagnostica: storico dei controlli scritti da `logDatabaseCheck()` (status,
  // latenza ed errore). Richiede una sessione, a differenza di `/api/health`.
  registerDatabaseRoutes(app, { db, config });
  // Cronotermostato: solo persistenza, i comandi li pubblica il job periodico
  // (`createClimateScheduler`, avviato da `server/index.ts`).
  registerClimateRoutes(app, { db, config });
  // Automazioni: le route scrivono su PostgreSQL e ricaricano la cache del
  // motore; il broker lo tocca solo il motore.
  registerAutomationRoutes(app, { db, config, automations });
  // Display a parete: auto-registrazione all'avvio, configurazione centralizzata
  // e sync real-time via `wallos/system/kiosk/:id/config_updated`.
  registerKioskRoutes(app, { db, config, publisher: kioskPublisher });
  // Planimetria schematica: piani, geometrie delle stanze e marker dei device.
  // Il salvataggio bulk pubblica `floor_updated` sul topic di topologia, quindi
  // ogni pannello invalida `['floors']` e `['topology']` senza reload.
  registerFloorRoutes(app, { db, config, events: topologyEvents });

  app.addHook('onClose', async () => {
    await automations.stop();
    await kioskPublisher.close();
    await topologyEvents.close();
    await db.close();
  });

  return { app, db, automations };
}
