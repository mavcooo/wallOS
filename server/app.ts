import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig } from './config.js';
import { AuthDb } from './db.js';
import { HttpError } from './http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { hashSecret, randomToken } from './security.js';
import { seedDatabase } from './seed.js';
import type { AuthConfig } from './types.js';

export interface BuildAppOptions {
  config?: AuthConfig;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: AuthDb;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Crea l'istanza Fastify (usata anche dai test con `inject`).
 * L'unico punto in cui vengono toccati DB, policy e segreti è questo.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const db = new AuthDb(config.dbPath);

  await seedDatabase(db, config);
  db.purgeExpiredRefreshTokens();

  // Hash di confronto per il login: evita di distinguere via timing
  // "utente inesistente" da "password errata".
  const dummyPasswordHash = await hashSecret(randomToken(), config.bcryptRounds);

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  // Difesa CSRF aggiuntiva rispetto a SameSite=Strict: le richieste che
  // modificano stato devono arrivare da un Origin esplicitamente consentito.
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return;
    if (!config.corsOrigins.includes(origin)) {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Origin non consentita');
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

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerAuthRoutes(app, { db, config, dummyPasswordHash });

  app.addHook('onClose', async () => {
    db.close();
  });

  return { app, db };
}
