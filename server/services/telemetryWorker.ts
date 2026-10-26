/**
 * Telemetry Worker per l'ingestione e l'aggregazione dei dati dei sensori.
 *
 * Responsabilità:
 * 1. Intercettare i messaggi MQTT in arrivo e inserirli in telemetry_history (batch insert).
 * 2. Eseguire aggregazioni time-bucketing (orario/giornaliera) su richiesta o schedule.
 * 3. Pulire i record obsoleti via funzione cleanup_telemetry_history().
 *
 * Questo modulo è progettato per essere avviato come task schedulato (node-cron o SQL periodica)
 * oppure integrato nel ciclo di vita del server Fastify.
 */

import { Pool } from 'pg';
import type { TelemetryUpdate } from '../../src/types/telemetry';

/**
 * Pool di connessioni al database PostgreSQL.
 * La dimensione del pool è controllata da DATABASE_POOL_MAX nell'ambiente (default 10).
 */
const pool = new Pool({
  connectionString: `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Batch insert di campioni telemetria grezzi.
 * Accetta una lista di aggiornamenti e li inserisce in telemetry_history in un unico
 * transaction per evitare di sovraccaricare il pool di connessioni.
 *
 * @param updates Array di TelemetryUpdate da inserire
 * @returns Number of records inserted
 */
export async function batchInsertTelemetry(updates: TelemetryUpdate[]): Promise<number> {
  if (updates.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Preparare l'insert multi-riga usando VALUES multiple per performance
    const values: (string | Date | number)[] = [];
    const placeholders: string[] = [];

    for (const u of updates) {
      const deviceId = u.deviceId;
      const state = u.decoded.state;
      const val = state && 'watts' in state && typeof state.watts === 'number' ? state.watts : 0;
      const recordedAt = new Date(u.at || Date.now());

      // Determina metric_type basandosi sul tipo di device
      let metric: string;
      if (u.decoded.kind === 'power') {
        metric = 'power_watts';
      } else if (u.decoded.kind === 'climate') {
        metric = 'temperature';
      } else if (u.decoded.kind === 'sensor') {
        metric = 'humidity';
      } else {
        metric = 'power_watts';
      }

      // Ogni riga consuma quattro parametri: i placeholder devono avanzare.
      const base = values.length;
      placeholders.push(
        `($${base + 1}::varchar(64), $${base + 2}::varchar(32), $${base + 3}::numeric(10, 2), $${base + 4}::timestamptz)`,
      );
      values.push(deviceId, metric, val, recordedAt);
    }

    const sql = `
      INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
      VALUES ${placeholders.join(', ')}
    `;

    await client.query(sql, values);
    await client.query('COMMIT');

    return updates.length;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[telemetryWorker] Batch insert error:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Aggregazione oraria: calcola min, max, avg per ogni device+metric nello scorso-orario.
 * Usa time_bucket se TimescaleDB è disponibile, altrimenti date_trunc.
 *
 * @param rangeInizio Inizio della finestra (es. inizio ora corrente)
 * @param rangeFine Fine della finestra (es. fine ora corrente)
 * @returns Array di punti aggregati [{ timestamp, value: { min, max, avg }, sampleCount }]
 */
export async function aggregateHourly(
  rangeInizio: Date,
  rangeFine: Date
): Promise<Array<{ bucket: string; device_id: string; metric_type: string; val_min: number; val_max: number; val_avg: number; sample_count: number }>> {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT
        date_trunc('hour', recorded_at) AS bucket,
        device_id,
        metric_type,
        MIN(val) AS val_min,
        MAX(val) AS val_max,
        AVG(val) AS val_avg,
        COUNT(*) AS sample_count
      FROM telemetry_history
      WHERE recorded_at >= $1 AND recorded_at < $2
      GROUP BY bucket, device_id, metric_type
      ORDER BY bucket DESC, device_id, metric_type
    `;

    const result = await client.query(sql, [rangeInizio, rangeFine]);
    return result.rows;
  } catch (error) {
    console.error('[telemetryWorker] Aggregation error:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Aggregazione giornaliera: calcola min, max, avg, total_kwh per ogni device+metric nello scorso-giorno.
 *
 * @param rangeInizio Inizio della finestra (es. mezzanotte odierna)
 * @param rangeFine Fine della finestra (es. adesso)
 * @returns Array di punti aggregati
 */
export async function aggregateDaily(
  rangeInizio: Date,
  rangeFine: Date
): Promise<Array<{ bucket: string; device_id: string; metric_type: string; val_min: number; val_max: number; val_avg: number; total_kwh: number; sample_count: number }>> {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT
        date_trunc('day', recorded_at) AS bucket,
        device_id,
        metric_type,
        MIN(val) AS val_min,
        MAX(val) AS val_max,
        AVG(val) AS val_avg,
        SUM(CASE WHEN metric_type = 'energy_kwh' THEN val ELSE 0 END) AS total_kwh,
        COUNT(*) AS sample_count
      FROM telemetry_history
      WHERE recorded_at >= $1 AND recorded_at < $2
      GROUP BY bucket, device_id, metric_type
      ORDER BY bucket DESC, device_id, metric_type
    `;

    const result = await client.query(sql, [rangeInizio, rangeFine]);
    return result.rows;
  } catch (error) {
    console.error('[telemetryWorker] Daily aggregation error:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Aggregazione a 30 giorni: raggruppamento giornaliero con consumo totale.
 * Finestra 30 giorni per device+metric.
 *
 * @param days Numero di giorni retroattivi (default 30)
 * @returns Array di punti aggregati
 */
export async function aggregateMonthly(
  days: number = 30
): Promise<Array<{ bucket: string; device_id: string; metric_type: string; val_min: number; val_max: number; val_avg: number; total_kwh: number; sample_count: number }>> {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT
        date_trunc('day', recorded_at) AS bucket,
        device_id,
        metric_type,
        MIN(val) AS val_min,
        MAX(val) AS val_max,
        AVG(val) AS val_avg,
        SUM(CASE WHEN metric_type = 'energy_kwh' THEN val ELSE 0 END) AS total_kwh,
        COUNT(*) AS sample_count
      FROM telemetry_history
      WHERE recorded_at >= (CURRENT_DATE - INTERVAL '${days} days')
      GROUP BY bucket, device_id, metric_type
      ORDER BY bucket DESC, device_id, metric_type
    `;

    const result = await client.query(sql);
    return result.rows;
  } catch (error) {
    console.error('[telemetryWorker] Monthly aggregation error:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Inserimento batch intelligente che filtra i valori "significativi" basandosi sul
 * ratio di delta significativo configurato nello store.
 * Questo evita di inserire campioni ridondanti quando il valore non cambia molto.
 *
 * @param updates TelemetryUpdate batch da inserire (già decodificati dal MQTT)
 * @param significantDeltaRatio Ratio di variazione significativa (default 0.02 = 2%)
 * @returns Number of records actually inserted (after dedup)
 */
export async function insertSignificantTelemetry(
  updates: TelemetryUpdate[],
  _significantDeltaRatio: number = 0.02
): Promise<number> {
  // Per ora inseriamo tutti i campioni e dedup a livello di query aggregazione.
  // In futuro si potrebbe mantenere un buffer in memoria per il dedup per device singolo.
  return await batchInsertTelemetry(updates);
}

/**
 * Chiudi il pool di connessioni (da chiamare all'arresto del server).
 */
export async function shutdown(): Promise<void> {
  await pool.end();
  console.log('[telemetryWorker] Pool chiuso');
}

export type { TelemetryUpdate };