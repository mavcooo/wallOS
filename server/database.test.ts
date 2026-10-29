import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { checkDatabaseHealth, Database, logDatabaseCheck } from './db.js';
import type { AuthConfig } from './types.js';

const PASSWORD = 'admin-password-123';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

function testEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    AUTO_SEED: 'true',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN: '2468',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  };
}

async function setup(): Promise<{ app: FastifyInstance; db: Database; config: AuthConfig }> {
  const config = loadConfig(testEnv());

  const engine = new PGlite();
  openEngines.push(engine);
  const db = new Database({
    connectionString: config.databaseUrl,
    client: {
      async query<T>(sql: string, params?: readonly unknown[]) {
        const result = await engine.query<T>(sql, params ? [...params] : undefined);
        return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
      },
      async exec(sql: string) {
        await engine.exec(sql);
      },
    },
  });

  const { app } = await buildApp({ config, db });
  openApps.push(app);
  return { app, db, config };
}

async function login(app: FastifyInstance): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);

  const cookies: Record<string, string> = {};
  for (const header of response.headers['set-cookie'] ?? []) {
    const pair = String(header).split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return cookies;
}

interface HistoryDto {
  id: string;
  status: string;
  latencyMs: number;
  checkedAt: string;
  errorMessage: string | null;
}

async function seedChecks(db: Database): Promise<void> {
  await db.client.query(
    `INSERT INTO db_health_checks (status, latency_ms, checked_at, error_message)
     VALUES
       ('healthy', 12, NOW() - INTERVAL '3 minutes', NULL),
       ('degraded', 640, NOW() - INTERVAL '2 minutes', NULL),
       ('down', 5000, NOW() - INTERVAL '1 minute', 'ECONNREFUSED')`,
  );
}

describe('GET /api/database/history', () => {
  it('richiede una sessione: lo storico non è un endpoint pubblico', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/api/database/history' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'UNAUTHENTICATED' });
  });

  it('restituisce gli ultimi controlli dal più recente con latenza ed errore', async () => {
    const { app, db } = await setup();
    await seedChecks(db);
    const cookies = await login(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/database/history',
      cookies,
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json<HistoryDto[]>();
    expect(rows).toHaveLength(3);

    // Ordine cronologico decrescente: il down è il controllo più recente.
    expect(rows.map((row) => row.status)).toEqual(['down', 'degraded', 'healthy']);
    expect(rows[0]).toMatchObject({ latencyMs: 5000, errorMessage: 'ECONNREFUSED' });
    expect(rows[1]).toMatchObject({ latencyMs: 640, errorMessage: null });
    expect(rows[2]).toMatchObject({ latencyMs: 12, errorMessage: null });

    // `TIMESTAMPTZ` serializzato in ISO 8601 e id BIGSERIAL come stringa.
    expect(typeof rows[0]?.id).toBe('string');
    expect(Number.isNaN(Date.parse(rows[0]?.checkedAt ?? ''))).toBe(false);
    expect(Date.parse(rows[0]?.checkedAt ?? '')).toBeGreaterThan(
      Date.parse(rows[1]?.checkedAt ?? ''),
    );
  });

  it('applica il limite della query e lo limita a 100', async () => {
    const { app, db } = await setup();
    await seedChecks(db);
    const cookies = await login(app);

    const limited = await app.inject({
      method: 'GET',
      url: '/api/database/history?limit=2',
      cookies,
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json<HistoryDto[]>()).toHaveLength(2);

    // Un limite non numerico ricade sul default; uno enorme resta dentro il tetto.
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/database/history?limit=abc',
      cookies,
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json<HistoryDto[]>()).toHaveLength(3);

    const clamped = await app.inject({
      method: 'GET',
      url: '/api/database/history?limit=999',
      cookies,
    });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json<HistoryDto[]>()).toHaveLength(3);
  });
});

describe('persistenza dell’audit', () => {
  it('`logDatabaseCheck` scrive una riga con stato, latenza ed errore', async () => {
    const { db } = await setup();

    await logDatabaseCheck('degraded', 812, 'TIMEOUT', db.client);

    const { rows } = await db.client.query<{
      status: string;
      latency_ms: number;
      error_message: string | null;
    }>('SELECT status, latency_ms, error_message FROM db_health_checks');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'degraded',
      latency_ms: 812,
      error_message: 'TIMEOUT',
    });
  });

  it('`checkDatabaseHealth` registra automaticamente ogni esito riuscito', async () => {
    const { db } = await setup();
    const before = await db.client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM db_health_checks',
    );

    await checkDatabaseHealth(db.client);

    const { rows } = await db.client.query<{
      status: string;
      latency_ms: number;
      error_message: string | null;
    }>('SELECT status, latency_ms, error_message FROM db_health_checks ORDER BY id DESC LIMIT 1');

    expect(rows).toHaveLength(1);
    expect(['healthy', 'degraded']).toContain(rows[0]?.status);
    expect(rows[0]?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]?.error_message).toBeNull();
    expect(Number(before.rows[0]?.count)).toBe(0);
  });

  it('un audit fallito non lancia e non rompe l’health check', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      async query() {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      },
    };

    await expect(
      logDatabaseCheck('down', 5000, 'ECONNREFUSED', broken),
    ).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(
      '[DB Audit] Impossibile scrivere il log di health check:',
      'connection refused',
    );

    errorLog.mockRestore();
  });
});
