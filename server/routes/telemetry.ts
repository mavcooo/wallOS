import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Database } from '../db.js';
import { HttpError } from '../http.js';
import type { TelemetryStatsStore } from '../services/telemetryWorker.js';
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

/**
 * Tetto assoluto di punti per risposta. Un pannello kiosk non disegna più di
 * qualche centinaio di punti: oltre, il costo è tutto del browser (parse del
 * JSON e ridisegno del canvas) senza alcun guadagno visivo. Il valore richiesto
 * dal client viene **clampato** a questo limite, mai rifiutato.
 */
export const MAX_TELEMETRY_POINTS = 2000;

/** Pagina di default in modalità raw (export/diagnostica). */
const RAW_DEFAULT_LIMIT = 500;

/**
 * `limit` arriva dalla query string (quindi stringa): numerico intero positivo,
 * clampato a `MAX_TELEMETRY_POINTS`. Un valore non numerico resta un 400.
 */
function pointsLimitSchema(fallback: number) {
  return z
    .preprocess((value) => {
      if (value === undefined || value === null || value === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : value;
    }, z.number().int().min(1, 'limit deve essere almeno 1'))
    .transform((value) => Math.min(value, MAX_TELEMETRY_POINTS));
}

const telemetryQuerySchema = z.object({
  deviceId: deviceIdSchema.optional(),
  metric: z.enum(TELEMETRY_METRICS).default('power_watts'),
  range: z.enum(['24h', '7d', '30d']).default('24h'),
  limit: pointsLimitSchema(MAX_TELEMETRY_POINTS),
});

/**
 * Modalità raw: qui `deviceId` e `metric` sono obbligatori, così un export non
 * può chiedere l'intera tabella senza filtro. `raw=false` ricade nello schema
 * aggregato (il flag viene ignorato).
 */
const rawQuerySchema = z.object({
  raw: z.enum(['true', '1']),
  deviceId: deviceIdSchema,
  metric: z.enum(TELEMETRY_METRICS),
  range: z.enum(['24h', '7d', '30d']).default('24h'),
  limit: pointsLimitSchema(RAW_DEFAULT_LIMIT),
  cursor: z.string().trim().min(1).max(256).optional(),
});

/** Cursore keyset su `(recorded_at, id)`: stabile anche con timestamp uguali. */
interface RawCursor {
  recordedAt: Date;
  id: string;
}

const CURSOR_SEPARATOR = '|';

function encodeCursor(recordedAt: Date, id: string): string {
  return Buffer.from(`${recordedAt.toISOString()}${CURSOR_SEPARATOR}${id}`, 'utf8').toString(
    'base64url',
  );
}

/** `null` per un cursore malformato: il chiamante risponde 400. */
function decodeCursor(value: string): RawCursor | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const separator = text.indexOf(CURSOR_SEPARATOR);
    if (separator <= 0) return null;
    const timestamp = Date.parse(text.slice(0, separator));
    const id = text.slice(separator + 1);
    if (!Number.isFinite(timestamp) || !/^\d+$/.test(id)) return null;
    return { recordedAt: new Date(timestamp), id };
  } catch {
    return null;
  }
}

/**
 * Bucket e finestra per intervallo. L'espressione SQL è un letterale del modulo
 * scelto da una whitelist: nessun frammento arriva dal client, che fornisce
 * solo i parametri (`$1` metric, `$2` intervallo, `$3` device).
 */
/** Esportati per i test di performance: unica fonte dell'SQL aggregato. */
export const RANGE_BUCKETS: Record<
  TelemetryRange,
  {
    interval: string;
    bucketLabel: string;
    bucketExpression: string;
    bucketWidth: string;
    /** Primo bucket allineato che copre l'inizio della finestra. */
    seriesStart: string;
  }
> = {
  // 24 h → 48 punti da 30 minuti: abbastanza fitti per la forma del carico,
  // abbastanza radi per non disegnare 1440 campioni grezzi.
  '24h': {
    interval: '24 hours',
    bucketLabel: '30m',
    bucketExpression:
      "date_trunc('hour', recorded_at) + INTERVAL '30 minutes' * FLOOR(date_part('minute', recorded_at) / 30)",
    bucketWidth: '30 minutes',
    seriesStart: "date_trunc('hour', NOW() - $2::interval)",
  },
  '7d': {
    interval: '7 days',
    bucketLabel: '1h',
    bucketExpression: "date_trunc('hour', recorded_at)",
    bucketWidth: '1 hour',
    seriesStart: "date_trunc('hour', NOW() - $2::interval)",
  },
  '30d': {
    interval: '30 days',
    bucketLabel: '1d',
    bucketExpression: "date_trunc('day', recorded_at)",
    bucketWidth: '1 day',
    seriesStart: "date_trunc('day', NOW() - $2::interval)",
  },
};

interface HistoryRow {
  timestamp: Date | string;
  avg: string | number;
  min: string | number | null;
  max: string | number | null;
  last: string | number | null;
  samples: string | number;
}

interface RawHistoryRow {
  id: string | number | bigint;
  val: string | number;
  recorded_at: Date | string;
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
 * estremi per device, così restano un limite reale del carico totale; `last`
 * somma l'ultimo campione di ogni device, cioè il carico istantaneo di casa a
 * fine bucket.
 *
 * Il downsampling è interamente in SQL: nessuna riga grezza attraversa la
 * rete, e `LIMIT` è l'ultima barriera al budget di punti.
 *
 * Sul singolo device i bucket nascono da `generate_series` (uno per
 * intervallo) e ogni bucket aggrega con un range scan sull'indice
 * `(device_id, metric_type, recorded_at DESC)`: niente sort globale delle 100k
 * righe, quindi la query 30d resta nello stesso ordine di grandezza dei bucket
 * (48/168/30) invece di crescere con i campioni. `last` è un `LIMIT 1` sulla
 * serie discendente dello stesso range.
 *
 * Per la casa (multi-device) serve prima l'aggregato per device, poi la somma:
 * è l'unico punto in cui la query deve raggruppare l'intera finestra.
 *
 * Larghezza e allineamento dei bucket sono letterali del modulo (`bucketWidth`,
 * `seriesStart`), mai input del client.
 */
export function historySql(
  bucketExpression: string,
  bucketWidth: string,
  seriesStart: string,
  house: boolean,
): string {
  if (!house) {
    return `SELECT
         b.bucket AS "timestamp",
         a.avg,
         a.min,
         a.max,
         a.samples,
         (SELECT h2.val::numeric(10, 2)
          FROM telemetry_history h2
          WHERE h2.device_id = $3
            AND h2.metric_type = $1
            AND h2.recorded_at >= GREATEST(b.bucket, NOW() - $2::interval)
            AND h2.recorded_at < b.bucket + INTERVAL '${bucketWidth}'
          ORDER BY h2.recorded_at DESC, h2.id DESC
          LIMIT 1) AS "last"
       FROM generate_series(
         ${seriesStart},
         NOW(),
         INTERVAL '${bucketWidth}'
       ) AS b(bucket)
       CROSS JOIN LATERAL (
         SELECT
           AVG(val)::numeric(10, 2) AS "avg",
           MIN(val)::numeric(10, 2) AS "min",
           MAX(val)::numeric(10, 2) AS "max",
           COUNT(*)::int AS "samples"
         FROM telemetry_history h
         WHERE h.device_id = $3
           AND h.metric_type = $1
           AND h.recorded_at >= GREATEST(b.bucket, NOW() - $2::interval)
           AND h.recorded_at < b.bucket + INTERVAL '${bucketWidth}'
       ) AS a
       WHERE a.samples > 0
       ORDER BY 1 ASC
       LIMIT $4`;
  }

  return `WITH agg AS (
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
       ), with_last AS (
         SELECT
           agg.*,
           (SELECT h2.val::numeric(10, 2)
            FROM telemetry_history h2
            WHERE h2.device_id = agg.device_id
              AND h2.metric_type = $1
              AND h2.recorded_at >= GREATEST(agg.bucket, NOW() - $2::interval)
              AND h2.recorded_at < agg.bucket + INTERVAL '${bucketWidth}'
            ORDER BY h2.recorded_at DESC, h2.id DESC
            LIMIT 1) AS val_last
         FROM agg
       )
       SELECT
         bucket AS "timestamp",
         SUM(val_avg)::numeric(12, 2) AS "avg",
         SUM(val_min)::numeric(12, 2) AS "min",
         SUM(val_max)::numeric(12, 2) AS "max",
         SUM(val_last)::numeric(12, 2) AS "last",
         SUM(samples)::int AS "samples"
       FROM with_last
       GROUP BY 1
       ORDER BY 1 ASC
       LIMIT $3`;
}

/**
 * Pagina di campioni grezzi, keyset su `(recorded_at, id)` in ordine
 * decrescente (export dal più recente). `$4`/`$5` valgono NULL alla prima
 * pagina, dove il confronto è neutralizzato dalla condizione.
 */
function rawHistorySql(): string {
  return `SELECT id, val, recorded_at
       FROM telemetry_history
       WHERE device_id = $1
         AND metric_type = $2
         AND recorded_at >= NOW() - $3::interval
         AND ($4::timestamptz IS NULL
              OR (recorded_at, id) < ($4::timestamptz, $5::bigint))
       ORDER BY recorded_at DESC, id DESC
       LIMIT $6`;
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
 * Serie storica **aggregata server-side** per device+metrica:
 * - `24h` → bucket da 30 minuti (48 punti);
 * - `7d` → bucket orario (168 punti);
 * - `30d` → bucket giornaliero (30 punti).
 *
 * Ogni punto porta `avg`, `min`, `max`, `last` e il numero di campioni: la
 * media è la linea, gli estremi sono la banda/tooltip del grafico, quindi un
 * picco di accensione non viene cancellato dal downsampling.
 *
 * Senza `deviceId` restituisce l'aggregato di tutta la casa: in ogni bucket il
 * valore è la somma delle medie per device (vedi `historySql`). `limit` è
 * clampato a `MAX_TELEMETRY_POINTS` e applicato anche in SQL.
 *
 * Con `?raw=true` la risposta è invece una pagina di campioni grezzi: qui
 * `deviceId` e `metric` sono obbligatori e la paginazione è keyset su
 * `(recorded_at, id)` con `hasMore`/`nextCursor`.
 */
export function registerTelemetryRoutes(app: FastifyInstance, deps: TelemetryDeps): void {
  app.get('/api/telemetry/history', { preHandler: requireAuth(deps) }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const wantsRaw = query['raw'] === 'true' || query['raw'] === '1';

    if (wantsRaw) {
      const parsed = rawQuerySchema.safeParse(query);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'INVALID_QUERY',
          'In modalità raw deviceId, metric e raw=true sono obbligatori',
        );
      }

      const { deviceId, metric, range, limit, cursor: rawCursor } = parsed.data;
      const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
      if (rawCursor !== undefined && cursor === null) {
        throw new HttpError(400, 'INVALID_QUERY', 'cursor non valido');
      }

      const result = await deps.db.client.query<RawHistoryRow>(rawHistorySql(), [
        deviceId,
        metric,
        RANGE_BUCKETS[range].interval,
        cursor?.recordedAt ?? null,
        cursor?.id ?? null,
        // Una riga in più serve solo a capire se esiste la pagina successiva.
        limit + 1,
      ]);

      const hasMore = result.rows.length > limit;
      const page = hasMore ? result.rows.slice(0, limit) : result.rows;
      const points = page.map((row) => {
        const recordedAt = toDate(row.recorded_at);
        return {
          id: String(row.id),
          timestamp: recordedAt.getTime(),
          recordedAt: recordedAt.toISOString(),
          value: Number(row.val),
        };
      });
      const oldest = page[page.length - 1];

      return reply.send({
        raw: true,
        deviceId,
        metric,
        range,
        limit,
        points,
        pointCount: points.length,
        hasMore,
        nextCursor:
          hasMore && oldest
            ? encodeCursor(toDate(oldest.recorded_at), String(oldest.id))
            : null,
      });
    }

    const parsed = telemetryQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_QUERY', 'Parametri di query non validi');
    }

    const { deviceId, metric, range, limit } = parsed.data;
    const bucket = RANGE_BUCKETS[range];
    const sql = historySql(
      bucket.bucketExpression,
      bucket.bucketWidth,
      bucket.seriesStart,
      deviceId === undefined,
    );

    const result = await deps.db.client.query<HistoryRow>(
      sql,
      deviceId === undefined
        ? [metric, bucket.interval, limit]
        : [metric, bucket.interval, deviceId, limit],
    );

    const points = result.rows.map((row) => {
      const avg = toNumber(row.avg) ?? 0;
      return {
        timestamp: toDate(row.timestamp).getTime(),
        // `value` resta l'alias storico della media per i client esistenti.
        value: avg,
        avg,
        min: toNumber(row.min),
        max: toNumber(row.max),
        last: toNumber(row.last),
        samples: Number(row.samples),
      };
    });

    return reply.send({
      range,
      deviceId: deviceId ?? 'all',
      metric,
      bucket: bucket.bucketLabel,
      limit,
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
 * GET /api/telemetry/stats
 *
 * Diagnostica del worker di ingestion: contatori dall'avvio del processo e
 * istante ISO dell'ultimo batch/retention. Richiede una sessione come le
 * altre rotte di telemetria (la pagina Energia non la usa).
 */
export function registerTelemetryStatsRoutes(
  app: FastifyInstance,
  deps: TelemetryDeps & { stats: TelemetryStatsStore },
): void {
  app.get('/api/telemetry/stats', { preHandler: requireAuth(deps) }, async (_request, reply) =>
    reply.send(deps.stats.snapshot()),
  );
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
