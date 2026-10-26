import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { loadConfig } from './config.js';
import { Database, shortVersion } from './db.js';
import { HttpError } from './http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerClimateRoutes } from './routes/climate.js';
import { registerTopologyRoutes } from './routes/topology.js';
import { registerTopologyEventRoutes } from './routes/topologyEvents.js';
import { registerUserRoutes } from './routes/users.js';
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
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Database;
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
  await seedDatabase(db, config);
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
  app.get('/api/health', async (_request, reply) => {
    const startedAt = Date.now();
    try {
      const info = await db.serverInfo();
      return {
        status: 'ok',
        database: {
          status: 'up',
          version: shortVersion(info.version),
          latencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return reply.code(503).send({
        status: 'degraded',
        database: {
          status: 'down',
          // Codice PostgreSQL/Node (es. ECONNREFUSED): niente host o password.
          error: typeof code === 'string' ? code : 'DATABASE_UNAVAILABLE',
          latencyMs: Date.now() - startedAt,
        },
      });
    }
  });

  const topologyEvents =
    options.topologyEvents ?? createTopologyEventBus(config, app.log);

  registerAuthRoutes(app, { db, config, dummyPasswordHash });
  registerUserRoutes(app, { db, config });
  registerTopologyRoutes(app, { db, config, events: topologyEvents });
  // Ripiego SSE: i client la aprono solo quando la socket MQTT non è viva.
  registerTopologyEventRoutes(app, { db, config, events: topologyEvents });
  registerTelemetryRoutes(app, { db, config });
  registerTelemetrySummaryRoutes(app, { db, config });
  registerTelemetryIngestRoutes(app, { db, config });
  // Cronotermostato: solo persistenza, i comandi li pubblica il job periodico
  // (`createClimateScheduler`, avviato da `server/index.ts`).
  registerClimateRoutes(app, { db, config });

  app.addHook('onClose', async () => {
    await topologyEvents.close();
    await db.close();
  });

  return { app, db };
}
