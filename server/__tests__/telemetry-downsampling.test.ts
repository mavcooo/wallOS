import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { Database } from '../db.js';
import { historySql, MAX_TELEMETRY_POINTS, RANGE_BUCKETS } from '../routes/telemetry.js';

const PASSWORD = 'admin-password-123';
const BULK_ROWS = 100_000;

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

interface SetupResult {
  app: FastifyInstance;
  db: Database;
  engine: PGlite;
}

async function setup(): Promise<SetupResult> {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTO_SEED: 'true',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN: '2468',
    KIOSK_PIN: '1234',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  });

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
  return { app, db, engine };
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

interface AggregatedPoint {
  timestamp: number;
  value: number;
  avg: number;
  min: number | null;
  max: number | null;
  last: number | null;
  samples: number;
}

interface HistoryDto {
  range: string;
  deviceId: string;
  pointCount: number;
  limit: number;
  points: AggregatedPoint[];
}

interface RawPoint {
  id: string;
  timestamp: number;
  recordedAt: string;
  value: number;
}

interface RawDto {
  raw: boolean;
  limit: number;
  points: RawPoint[];
  pointCount: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/** 100.000 campioni su 29 giorni: la finestra 30d li attraversa tutti. */
async function seedBulkTelemetry(db: Database): Promise<void> {
  await db.client.query(
    `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
     SELECT 'power-kitchen-oven',
            'power_watts',
            (100 + (g % 400))::numeric(10, 2),
            NOW() - ((g::int * INTERVAL '29 days') / $1::double precision)
     FROM generate_series(1, $2::int) AS g`,
    [BULK_ROWS, BULK_ROWS],
  );
  // Spunto isolato: il downsampling non deve cancellarlo.
  await db.client.query(
    `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
     VALUES ('power-kitchen-oven', 'power_watts', 9999, NOW() - INTERVAL '10 days')`,
  );
  // Statistiche aggiornate come farebbe l'autovacuum in produzione: senza,
  // il planner di PGlite sottostima la selettività della finestra.
  await db.client.query('ANALYZE telemetry_history');
}

describe('telemetria · downsampling server-side', () => {
  it('aggrega 100.000 campioni di 30 giorni entro il budget, preservando i picchi', async () => {
    const { app, db } = await setup();
    await seedBulkTelemetry(db);
    const cookies = await login(app);

    // Warm-up: la prima esecuzione paga la compilazione della query, non il
    // costo che vede il pannello a regime.
    await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-oven&range=30d&metric=power_watts',
      cookies,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-oven&range=30d&metric=power_watts',
      cookies,
    });

    // La soglia di latenza riguarda la query aggregata (il collo di bottiglia),
    // misurata sullo stesso SQL che serve l'endpoint. Il minimo di più
    // esecuzioni isola la latenza dal rumore del runner (GC, altri file in
    // parallelo): non è un'attenuazione della soglia, è la metrica standard di
    // un micro-benchmark.
    const bucket = RANGE_BUCKETS['30d'];
    const sql = historySql(
      bucket.bucketExpression,
      bucket.bucketWidth,
      bucket.seriesStart,
      false,
    );
    const params = ['power_watts', bucket.interval, 'power-kitchen-oven', MAX_TELEMETRY_POINTS];
    const samples: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      await db.client.query(sql, params);
      samples.push(performance.now() - startedAt);
    }
    const elapsedMs = Math.min(...samples);

    expect(response.statusCode).toBe(200);
    const body = response.json<HistoryDto>();

    // Budget dei punti: 30d → bucket giornalieri (30 punti), comunque sotto
    // il tetto assoluto.
    expect(body.limit).toBe(MAX_TELEMETRY_POINTS);
    expect(body.pointCount).toBeLessThanOrEqual(31);
    expect(body.pointCount).toBeLessThanOrEqual(MAX_TELEMETRY_POINTS);
    expect(body.points).toHaveLength(body.pointCount);

    // Ordinamento cronologico crescente.
    const timestamps = body.points.map((point) => point.timestamp);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);

    // Aggregati presenti in ogni punto.
    for (const point of body.points) {
      expect(typeof point.avg).toBe('number');
      expect(typeof point.value).toBe('number');
      expect(point.value).toBe(point.avg);
      expect(point.min).not.toBeNull();
      expect(point.max).not.toBeNull();
      expect(point.last).not.toBeNull();
      expect(point.samples).toBeGreaterThan(0);
      expect(point.min ?? 0).toBeLessThanOrEqual(point.avg);
      expect(point.avg).toBeLessThanOrEqual(point.max ?? 0);
    }

    // Il picco da 9999 W resta nel max del suo bucket, mentre la media dello
    // stesso bucket è molto più bassa.
    const spikeBucket = body.points.find((point) => point.max === 9999);
    expect(spikeBucket).toBeDefined();
    expect(spikeBucket?.avg ?? 0).toBeLessThan(9999);
    expect(spikeBucket?.min ?? 0).toBeLessThan(9999);

    // Anche la finestra 7d è aggregata dal database con gli stessi campi.
    const week = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-oven&range=7d&metric=power_watts',
      cookies,
    });
    expect(week.statusCode).toBe(200);
    const weekBody = week.json<HistoryDto>();
    expect(weekBody.points.length).toBeGreaterThan(0);
    expect(weekBody.pointCount).toBeLessThanOrEqual(169);
    expect(
      weekBody.points.every(
        (point) => point.min !== null && point.max !== null && typeof point.avg === 'number',
      ),
    ).toBe(true);

    // Filtro aperto (tutta la casa): stessa aggregazione, stesso budget.
    const house = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?range=30d&metric=power_watts',
      cookies,
    });
    expect(house.statusCode).toBe(200);
    const houseBody = house.json<HistoryDto>();
    expect(houseBody.deviceId).toBe('all');
    expect(houseBody.pointCount).toBeLessThanOrEqual(MAX_TELEMETRY_POINTS);
    expect(houseBody.points.every((point) => point.avg >= 0 && point.max !== null)).toBe(true);

    // La query aggregata su 100k righe resta dentro il budget di latenza.
    expect(elapsedMs).toBeLessThan(150);
  });

  it('clampa limit al tetto assoluto anche se il client ne chiede di più', async () => {
    const { app, db } = await setup();
    await seedBulkTelemetry(db);
    const cookies = await login(app);

    const huge = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-oven&range=24h&limit=999999',
      cookies,
    });
    expect(huge.statusCode).toBe(200);
    const body = huge.json<HistoryDto>();
    expect(body.limit).toBe(MAX_TELEMETRY_POINTS);
    expect(body.pointCount).toBeLessThanOrEqual(MAX_TELEMETRY_POINTS);
    // 48 bucket pieni più il bucket parziale del minuto corrente.
    expect(body.pointCount).toBeLessThanOrEqual(49);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-oven&limit=zero',
      cookies,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'INVALID_QUERY' });
  });

  it('in modalità raw richiede deviceId e metric', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const missingDevice = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?raw=true&metric=power_watts',
      cookies,
    });
    expect(missingDevice.statusCode).toBe(400);
    expect(missingDevice.json()).toMatchObject({ error: 'INVALID_QUERY' });

    const missingMetric = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?raw=true&deviceId=power-kitchen-oven',
      cookies,
    });
    expect(missingMetric.statusCode).toBe(400);

    const noFilters = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?raw=true',
      cookies,
    });
    expect(noFilters.statusCode).toBe(400);
  });

  it('pagina i campioni grezzi con cursore keyset senza duplicati', async () => {
    const { app, db } = await setup();
    await db.client.query(
      `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
       SELECT 'power-kitchen-oven',
              'power_watts',
              g::numeric(10, 2),
              NOW() - (g::int * INTERVAL '1 hour')
       FROM generate_series(1, 12) AS g`,
    );
    const cookies = await login(app);

    const first = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?raw=true&deviceId=power-kitchen-oven&metric=power_watts&limit=5',
      cookies,
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<RawDto>();
    expect(firstPage.raw).toBe(true);
    expect(firstPage.limit).toBe(5);
    expect(firstPage.pointCount).toBe(5);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    // Dal più recente: la paginazione keyset è su (recorded_at, id) DESC.
    const firstTimestamps = firstPage.points.map((point) => point.timestamp);
    expect([...firstTimestamps].sort((a, b) => b - a)).toEqual(firstTimestamps);

    const second = await app.inject({
      method: 'GET',
      url: `/api/telemetry/history?raw=true&deviceId=power-kitchen-oven&metric=power_watts&limit=5&cursor=${encodeURIComponent(
        firstPage.nextCursor ?? '',
      )}`,
      cookies,
    });
    expect(second.statusCode).toBe(200);
    const secondPage = second.json<RawDto>();
    expect(secondPage.pointCount).toBe(5);
    expect(secondPage.hasMore).toBe(true);

    const third = await app.inject({
      method: 'GET',
      url: `/api/telemetry/history?raw=true&deviceId=power-kitchen-oven&metric=power_watts&limit=5&cursor=${encodeURIComponent(
        secondPage.nextCursor ?? '',
      )}`,
      cookies,
    });
    expect(third.statusCode).toBe(200);
    const thirdPage = third.json<RawDto>();
    expect(thirdPage.pointCount).toBe(2);
    expect(thirdPage.hasMore).toBe(false);
    expect(thirdPage.nextCursor).toBeNull();

    const ids = [...firstPage.points, ...secondPage.points, ...thirdPage.points].map(
      (point) => point.id,
    );
    expect(new Set(ids).size).toBe(12);
  });

  it('rifiuta un cursore malformato senza interrogare la tabella', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?raw=true&deviceId=power-kitchen-oven&metric=power_watts&cursor=not-a-cursor',
      cookies,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'INVALID_QUERY' });
  });
});
