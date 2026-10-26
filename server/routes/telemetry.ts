import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Database } from '../db.js';
import { HttpError } from '../http.js';
import { requireAuth, requireRole } from '../session.js';
import type { AuthConfig } from '../types.js';

interface TelemetryDeps {
  db: Database;
  config: AuthConfig;
}

/** Stesse metriche salvate dal worker MQTT in `telemetry_history`. */
const telemetryQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  metric: z.enum(['power_watts', 'energy_kwh', 'temperature', 'humidity']).optional(),
  range: z.enum(['24h', '7d', '30d']).default('24h'),
});

type TelemetryRange = z.infer<typeof telemetryQuerySchema>['range'];

const RANGE_MS: Record<TelemetryRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function resolveWindow(range: TelemetryRange): { from: Date; to: Date } {
  const to = new Date();
  return { from: new Date(to.getTime() - RANGE_MS[range]), to };
}

interface HistoryRow {
  timestamp: Date | string;
  value: string | number;
  min: string | number | null;
  max: string | number | null;
}

interface SummaryRow {
  min_val: string | number | null;
  max_val: string | number | null;
  avg_val: string | number | null;
  total_kwh: string | number | null;
  sample_count: string | number | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * GET /api/telemetry/history
 * Serie storica per device/metrica; senza filtri restituisce tutti i campioni
 * della finestra, che il client riduce per il grafico.
 */
export function registerTelemetryRoutes(app: FastifyInstance, deps: TelemetryDeps): void {
  app.get('/api/telemetry/history', { preHandler: requireAuth(deps) }, async (request, reply) => {
    const parsed = telemetryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_QUERY', 'Parametri di query non validi');
    }

    const { deviceId, metric, range } = parsed.data;
    const { from, to } = resolveWindow(range);

    const conditions = ['recorded_at >= $1::timestamptz', 'recorded_at < $2::timestamptz'];
    const params: unknown[] = [from, to];

    if (deviceId) {
      params.push(deviceId);
      conditions.push(`device_id = $${params.length}`);
    }
    if (metric) {
      params.push(metric);
      conditions.push(`metric_type = $${params.length}`);
    }

    const result = await deps.db.client.query<HistoryRow>(
      `SELECT
         recorded_at AS timestamp,
         val AS value,
         MIN(val) OVER (PARTITION BY device_id, metric_type, date_trunc('hour', recorded_at)) AS min,
         MAX(val) OVER (PARTITION BY device_id, metric_type, date_trunc('hour', recorded_at)) AS max
       FROM telemetry_history
       WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at ASC`,
      params,
    );

    const points = result.rows.map((row) => ({
      timestamp: toDate(row.timestamp).getTime(),
      value: Number(row.value),
      ...(row.min !== null ? { min: Number(row.min) } : {}),
      ...(row.max !== null ? { max: Number(row.max) } : {}),
    }));

    return reply.send({
      range,
      deviceId: deviceId ?? 'all',
      metric: metric ?? 'all',
      points,
      pointCount: points.length,
    });
  });
}

/**
 * GET /api/telemetry/summary
 * Minimo, massimo, media e totale energia della finestra richiesta.
 */
export function registerTelemetrySummaryRoutes(app: FastifyInstance, deps: TelemetryDeps): void {
  app.get('/api/telemetry/summary', { preHandler: requireAuth(deps) }, async (request, reply) => {
    const parsed = telemetryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_QUERY', 'Parametri di query non validi');
    }

    const { deviceId, metric, range } = parsed.data;
    const { from, to } = resolveWindow(range);

    const conditions = ['recorded_at >= $1::timestamptz', 'recorded_at < $2::timestamptz'];
    const params: unknown[] = [from, to];

    if (deviceId) {
      params.push(deviceId);
      conditions.push(`device_id = $${params.length}`);
    }
    if (metric) {
      params.push(metric);
      conditions.push(`metric_type = $${params.length}`);
    }

    const result = await deps.db.client.query<SummaryRow>(
      `SELECT
         MIN(val) AS min_val,
         MAX(val) AS max_val,
         AVG(val) AS avg_val,
         COUNT(*) AS sample_count,
         SUM(CASE WHEN metric_type = 'energy_kwh' THEN val ELSE 0 END) AS total_kwh
       FROM telemetry_history
       WHERE ${conditions.join(' AND ')}`,
      params,
    );

    const row = result.rows[0];
    const summary = {
      min: row ? toNumber(row.min_val) : null,
      max: row ? toNumber(row.max_val) : null,
      avg: row ? toNumber(row.avg_val) : null,
      total: row ? toNumber(row.total_kwh) : null,
      count: row && row.sample_count !== null ? Number(row.sample_count) : 0,
    };

    return reply.send({
      range,
      deviceId: deviceId ?? 'all',
      metric: metric ?? 'all',
      summary,
    });
  });
}

/**
 * POST /api/telemetry/ingest
 * Inserimento manuale riservato agli admin (test e backfill).
 */
export function registerTelemetryIngestRoutes(app: FastifyInstance, deps: TelemetryDeps): void {
  app.post(
    '/api/telemetry/ingest',
    { preHandler: requireRole(deps, ['admin']) },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        deviceId?: unknown;
        metricType?: unknown;
        val?: unknown;
        recordedAt?: unknown;
      };

      if (
        typeof body.deviceId !== 'string' ||
        typeof body.metricType !== 'string' ||
        typeof body.val !== 'number' ||
        !Number.isFinite(body.val)
      ) {
        throw new HttpError(400, 'INVALID_BODY', 'deviceId, metricType e val sono obbligatori');
      }

      const recordedAt =
        typeof body.recordedAt === 'string' ? new Date(body.recordedAt) : new Date();
      if (Number.isNaN(recordedAt.getTime())) {
        throw new HttpError(400, 'INVALID_BODY', 'recordedAt non è una data valida');
      }

      const result = await deps.db.client.query<{ id: string }>(
        `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
         VALUES ($1::varchar(64), $2::varchar(32), $3::numeric(10, 2), $4::timestamptz)
         RETURNING id`,
        [body.deviceId, body.metricType, body.val, recordedAt],
      );

      return reply.code(201).send({ inserted: result.rows[0] ?? null });
    },
  );
}
