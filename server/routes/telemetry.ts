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

/** Stesse metriche scritte dal worker MQTT in `telemetry_history`. */
const TELEMETRY_METRICS = ['power_watts', 'energy_kwh', 'temperature', 'humidity'] as const;

type TelemetryRange = '24h' | '7d' | '30d';

/**
 * `devices.id` è uno slug testuale (`power-kitchen-oven`, `living-room-light`,
 * `plug_lavatrice`), non un UUID: la validazione deve accettare lo stesso
 * formato della tabella e dei topic MQTT (`stat/<device_id>/...`), altrimenti
 * ogni richiesta del grafico finisce in 400 e la pagina resta vuota.
 *
 * Il set di caratteri è lo stesso con cui nascono gli id (`SLUG_RE` in
 * `server/routes/topology.ts`): deve iniziare con lettera o cifra, poi lettere,
 * cifre, `-`, `_` e `:`. Lo spazio è escluso — in un id non esiste — e i due
 * punti sono ammessi perché i device scoperti dai bridge hanno id come
 * `zigbee:0x00158d0001`; qui però restano case-insensitive, così un id scritto
 * a mano non diventa un 400 ma una finestra vuota.
 *
 * Spazi, apici, slash e punto e virgola sono il segno di un client che sbaglia
 * (o di un tentativo di iniezione): la richiesta viene respinta prima di
 * arrivare a PostgreSQL, dove comunque il valore resta un parametro
 * posizionale e mai testo concatenato.
 */
const deviceIdSchema = z
  .string()
  .trim()
  .min(1, 'deviceId non può essere vuoto')
  .max(64, 'deviceId non può superare i 64 caratteri')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/,
    'deviceId deve iniziare con una lettera o una cifra e contenere solo lettere, cifre, trattini, underscore o due punti',
  );

const telemetryQuerySchema = z.object({
  deviceId: deviceIdSchema.optional(),
  metric: z.enum(TELEMETRY_METRICS).default('power_watts'),
  range: z.enum(['24h', '7d', '30d']).default('24h'),
});

/**
 * Bucket e finestra per intervallo. L'espressione SQL è un letterale del modulo
 * scelto da una whitelist: nessun frammento arriva dal client, che fornisce
 * solo i parametri (`$1` metric, `$2` intervallo, `$3` device).
 */
const RANGE_BUCKETS: Record<
  TelemetryRange,
  { interval: string; bucketLabel: string; bucketExpression: string }
> = {
  // 24 h → 48 punti da 30 minuti: abbastanza fitti per la forma del carico,
  // abbastanza radi per non disegnare 1440 campioni grezzi.
  '24h': {
    interval: '24 hours',
    bucketLabel: '30m',
    bucketExpression:
      "date_trunc('hour', recorded_at) + INTERVAL '30 minutes' * FLOOR(date_part('minute', recorded_at) / 30)",
  },
  '7d': {
    interval: '7 days',
    bucketLabel: '1h',
    bucketExpression: "date_trunc('hour', recorded_at)",
  },
  '30d': {
    interval: '30 days',
    bucketLabel: '1d',
    bucketExpression: "date_trunc('day', recorded_at)",
  },
};

interface HistoryRow {
  timestamp: Date | string;
  value: string | number;
  min: string | number | null;
  max: string | number | null;
  samples: string | number;
}

interface SummaryRow {
  min_val: string | number | null;
  max_val: string | number | null;
  avg_val: string | number | null;
  energy_delta: string | number | null;
  sample_count: string | number | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * `deviceId` assente = aggregato di tutta la casa. Il valore nel bucket non è
 * la somma dei campioni grezzi (un meter che campiona più spesso peserebbe di
 * più), ma la somma delle medie per device; `min`/`max` sommano i rispettivi
 * estremi per device, così restano un limite reale del carico totale.
 */
function historySql(bucketExpression: string, house: boolean): string {
  if (!house) {
    return `SELECT
         ${bucketExpression} AS "timestamp",
         AVG(val)::numeric(10, 2) AS "value",
         MIN(val)::numeric(10, 2) AS "min",
         MAX(val)::numeric(10, 2) AS "max",
         COUNT(*)::int AS "samples"
       FROM telemetry_history
       WHERE metric_type = $1 AND recorded_at >= NOW() - $2::interval AND device_id = $3
       GROUP BY 1
       ORDER BY 1 ASC`;
  }

  return `WITH per_device AS (
         SELECT
           ${bucketExpression} AS bucket,
           device_id,
           AVG(val)::numeric(10, 2) AS val_avg,
           MIN(val)::numeric(10, 2) AS val_min,
           MAX(val)::numeric(10, 2) AS val_max,
           COUNT(*)::int AS samples
         FROM telemetry_history
         WHERE metric_type = $1 AND recorded_at >= NOW() - $2::interval
         GROUP BY 1, 2
       )
       SELECT
         bucket AS "timestamp",
         SUM(val_avg)::numeric(12, 2) AS "value",
         SUM(val_min)::numeric(12, 2) AS "min",
         SUM(val_max)::numeric(12, 2) AS "max",
         SUM(samples)::int AS "samples"
       FROM per_device
       GROUP BY 1
       ORDER BY 1 ASC`;
}

/** Stessa logica di `historySql` applicata ai riepiloghi della finestra. */
function summarySql(bucketExpression: string, house: boolean): string {
  if (!house) {
    return `SELECT
         MIN(val) AS "min_val",
         MAX(val) AS "max_val",
         AVG(val)::numeric(10, 2) AS "avg_val",
         COUNT(*)::int AS "sample_count",
         CASE WHEN $1 = 'energy_kwh' THEN MAX(val) - MIN(val) END AS "energy_delta"
       FROM telemetry_history
       WHERE metric_type = $1 AND recorded_at >= NOW() - $2::interval AND device_id = $3`;
  }

  return `WITH per_device AS (
         SELECT
           ${bucketExpression} AS bucket,
           device_id,
           MIN(val)::numeric(10, 2) AS val_min,
           MAX(val)::numeric(10, 2) AS val_max,
           AVG(val)::numeric(10, 2) AS val_avg,
           COUNT(*)::int AS samples
         FROM telemetry_history
         WHERE metric_type = $1 AND recorded_at >= NOW() - $2::interval
         GROUP BY 1, 2
       ), house AS (
         SELECT
           bucket,
           SUM(val_min) AS val_min,
           SUM(val_max) AS val_max,
           SUM(val_avg) AS val_avg,
           SUM(samples)::int AS samples
         FROM per_device
         GROUP BY 1
       )
       SELECT
         MIN(val_min) AS "min_val",
         MAX(val_max) AS "max_val",
         AVG(val_avg)::numeric(10, 2) AS "avg_val",
         SUM(samples)::int AS "sample_count",
         CASE WHEN $1 = 'energy_kwh' THEN MAX(val_avg) - MIN(val_avg) END AS "energy_delta"
       FROM house`;
}

/**
 * GET /api/telemetry/history
 *
 * Serie storica **aggregata** per device+metrica:
 * - `24h` → bucket da 30 minuti (`AVG`, `MIN`, `MAX`);
 * - `7d` → bucket orario;
 * - `30d` → bucket giornaliero.
 *
 * Senza `deviceId` restituisce l'aggregato di tutta la casa: in ogni bucket il
 * valore è la somma delle medie per device. `points` è ordinato
 * cronologicamente e `timestamp` è epoch in ms, così il canvas del pannello
 * non deve interpretare formati SQL.
 */
export function registerTelemetryRoutes(app: FastifyInstance, deps: TelemetryDeps): void {
  app.get('/api/telemetry/history', { preHandler: requireAuth(deps) }, async (request, reply) => {
    const parsed = telemetryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_QUERY', 'Parametri di query non validi');
    }

    const { deviceId, metric, range } = parsed.data;
    const bucket = RANGE_BUCKETS[range];
    const sql = historySql(bucket.bucketExpression, deviceId === undefined);

    const result = await deps.db.client.query<HistoryRow>(
      sql,
      deviceId === undefined
        ? [metric, bucket.interval]
        : [metric, bucket.interval, deviceId],
    );

    const points = result.rows.map((row) => ({
      timestamp: toDate(row.timestamp).getTime(),
      value: Number(row.value),
      min: toNumber(row.min),
      max: toNumber(row.max),
      samples: Number(row.samples),
    }));

    return reply.send({
      range,
      deviceId: deviceId ?? 'all',
      metric,
      bucket: bucket.bucketLabel,
      points,
      pointCount: points.length,
    });
  });
}

/**
 * GET /api/telemetry/summary
 *
 * Minimo, picco massimo, media e totale della finestra. Per `energy_kwh`
 * `total` è il delta del contatore cumulativo (`MAX - MIN`): sommare i campioni
 * di un contatore che cresce darebbe un numero senza significato fisico.
 */
export function registerTelemetrySummaryRoutes(app: FastifyInstance, deps: TelemetryDeps): void {
  app.get('/api/telemetry/summary', { preHandler: requireAuth(deps) }, async (request, reply) => {
    const parsed = telemetryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_QUERY', 'Parametri di query non validi');
    }

    const { deviceId, metric, range } = parsed.data;
    const bucket = RANGE_BUCKETS[range];
    const sql = summarySql(bucket.bucketExpression, deviceId === undefined);

    const result = await deps.db.client.query<SummaryRow>(
      sql,
      deviceId === undefined
        ? [metric, bucket.interval]
        : [metric, bucket.interval, deviceId],
    );

    const row = result.rows[0];
    const summary = {
      min: row ? toNumber(row.min_val) : null,
      max: row ? toNumber(row.max_val) : null,
      avg: row ? toNumber(row.avg_val) : null,
      total: row ? toNumber(row.energy_delta) : null,
      count: row && row.sample_count !== null ? Number(row.sample_count) : 0,
    };

    return reply.send({
      range,
      deviceId: deviceId ?? 'all',
      metric,
      summary,
    });
  });
}

/**
 * POST /api/telemetry/ingest
 * Inserimento manuale riservato agli admin (backfill e test end-to-end).
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

      const deviceId = deviceIdSchema.safeParse(body.deviceId);
      const rawMetric = typeof body.metricType === 'string' ? body.metricType : '';
      const metricType = TELEMETRY_METRICS.find((metric) => metric === rawMetric);

      if (
        !deviceId.success ||
        metricType === undefined ||
        typeof body.val !== 'number' ||
        !Number.isFinite(body.val)
      ) {
        throw new HttpError(
          400,
          'INVALID_BODY',
          `deviceId, metricType (${TELEMETRY_METRICS.join(', ')}) e val numerico sono obbligatori`,
        );
      }

      const recordedAt =
        typeof body.recordedAt === 'string' ? new Date(body.recordedAt) : new Date();
      if (Number.isNaN(recordedAt.getTime())) {
        throw new HttpError(400, 'INVALID_BODY', 'recordedAt non è una data valida');
      }

      const device = await deps.db.client.query<{ id: string }>(
        'SELECT id FROM devices WHERE id = $1',
        [deviceId.data],
      );
      // `rows.length`, non `rowCount`: con PGlite nei test `rowCount` mappa
      // `affectedRows`, che per una SELECT vale 0.
      if (device.rows.length === 0) {
        throw new HttpError(404, 'DEVICE_NOT_FOUND', `Dispositivo ${deviceId.data} inesistente`);
      }

      const result = await deps.db.client.query<{ id: string }>(
        `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
         VALUES ($1::text, $2::varchar(32), $3::numeric(10, 2), $4::timestamptz)
         RETURNING id`,
        [deviceId.data, metricType, body.val, recordedAt],
      );

      return reply.code(201).send({ inserted: result.rows[0] ?? null });
    },
  );
}
