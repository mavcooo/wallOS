-- ----------------------------
-- 003_telemetry_history.sql - UP
-- ----------------------------
-- Table for high-frequency telemetry sampling (every 5-15 minutes)
-- Temporal partitioning based on monthly ranges for performance and retention.
-- Each raw partition keeps data for 30 days, then automatically cleans or archives.

-- Current partition (last month) - raw 5-15 min data
CREATE TABLE IF NOT EXISTS telemetry_history_y001 (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  metric_type VARCHAR(32) NOT NULL, -- 'power_watts', 'energy_kwh', 'temperature', 'humidity'
  val NUMERIC(10, 2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Index for time-series queries: device + metric + descending time
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time_y001 ON telemetry_history_y001 (device_id, metric_type, recorded_at DESC);
-- Partial index for the current month only - accelerates recent queries
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time_current_y001 ON telemetry_history_y001 (device_id, metric_type) WHERE recorded_at >= date_trunc('month', NOW()) - interval '1 month';

-- Historical partitions (30-day retention, one per month)
-- y002 = month-1, y003 = month-2, etc.
-- Ciascuna partizione ha gli stessi indici per query across-month coerenti
DO $$
DECLARE
  i INTEGER;
  part_name TEXT;
  part_expr TEXT;
BEGIN
  FOR i IN 1..11 LOOP
    part_name := 'telemetry_history_y' || lpad(i::text, 3, '0');
    part_expr := date_trunc('month', NOW()) - (i || ' month')::interval;
    
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I (
        id BIGSERIAL PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        metric_type VARCHAR(32) NOT NULL,
        val NUMERIC(10, 2) NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      ) PARTITION OF telemetry_history_y001
      FOR VALUES FROM (%L) TO (%L);',
      part_name,
      part_expr,
      part_expr + '1 month'
    );
    
    -- Copy indexes to each partition
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_telemetry_device_time_%I ON %I (device_id, metric_type, recorded_at DESC);', part_name, part_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_telemetry_device_time_curr_%I ON %I (device_id, metric_type) WHERE recorded_at >= date_trunc(''month'', NOW()) - interval ''1 month'';', part_name, part_name);
  END LOOP;
END $$;

-- Aggregated tables for hourly/daily pre-computed stats
-- Ora: raggruppamento orario per device+metric (24h+7d+30d queries fast)
CREATE TABLE IF NOT EXISTS telemetry_history_hour (
  bucket TIMESTAMPTZ NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  metric_type VARCHAR(32) NOT NULL,
  val_min NUMERIC(10, 2) NOT NULL,
  val_max NUMERIC(10, 2) NOT NULL,
  val_avg NUMERIC(10, 2) NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, device_id, metric_type)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_hour_device ON telemetry_history_hour (device_id, metric_type, bucket DESC);

-- Giorno: raggruppamento giornaliero per device+metric (consumo kWh, temp media)
CREATE TABLE IF NOT EXISTS telemetry_history_day (
  bucket DATE NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  metric_type VARCHAR(32) NOT NULL,
  val_min NUMERIC(10, 2) NOT NULL,
  val_max NUMERIC(10, 2) NOT NULL,
  val_avg NUMERIC(10, 2) NOT NULL,
  total_kwh NUMERIC(12, 2) NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, device_id, metric_type)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_day_device ON telemetry_history_day (device_id, metric_type, bucket DESC);

-- Retention policy: cleanup procedure per mantenere i soli campioni grezzi a 30 giorni
-- Esegui periodicamente (es. notte via cron o task SQL) per rimuovere partizioni vecchie > 30 giorni
CREATE OR REPLACE FUNCTION cleanup_telemetry_history() RETURNS INTEGER AS $$
DECLARE
  cutoff_ts TIMESTAMPTZ := date_trunc('month', NOW()) - interval '30 month';
  removed INTEGER := 0;
BEGIN
  -- Rimuovi partizioni vecchie da telemetry_history_y001 (es. y012, y013, ecc.)
  -- La logica si basa sul nome della partizione: se la data di inizio partezione è < cutoff, la eliminiamo
  FOR removed IN (
    DELETE FROM telemetry_history_y001
    WHERE recorded_at < cutoff_ts
    RETURNING 1
  ) LOOP
    -- Niente da fare qui: cancelliamo direttamente le righe dalla partizione corrente o vecchie
  END LOOP;
  
  -- Rimuovi partizioni vecchie dal ciclo DO precedente (y001..y011)
  FOR i IN 12..20 LOOP
    EXECUTE format('DELETE FROM %I WHERE recorded_at < $1', 'telemetry_history_y' || lpad(i::text, 3, '0')), cutoff_ts;
  END LOOP;
  
  -- Pulisci anche le tabelle aggregate obsolete (più di 14 giorni per hour, 30 per day)
  DELETE FROM telemetry_history_hour WHERE bucket < date_trunc('day', NOW()) - interval '14 day';
  DELETE FROM telemetry_history_day WHERE bucket < date_trunc('day', NOW()) - interval '30 day';
  
  RETURN removed;
END;
$$ LANGUAGE plpgsql;

-- Trigger per pulizia automatica su ogni inserzione (opzionale: solo per partition vecchie)
-- Nota: un trigger per tabella partitioned può essere costoso; preferiamo la procedura periodica.
COMMENT ON TABLE telemetry_history_y001 IS 'Partitioned telemetry history: raw samples every 5-15 min, 30-day retention per partition';
COMMON INDEX idx_telemetry_device_time_y001 IS 'Index on (device_id, metric_type, recorded_at DESC) for the current partition';
COMMENT ON INDEX idx_telemetry_device_time_curr_y001 IS 'Partial index for current month queries only';
COMMENT ON FUNCTION cleanup_telemetry_history() IS 'Periodic cleanup: removes raw samples older than 30 months from partitions, aggregated tables older than 14/30 days';

-- ----------------------------
-- 003_telemetry_history.sql - DOWN
-- ----------------------------
-- Drop all partitions and aggregated tables
DROP INDEX IF EXISTS idx_telemetry_device_time_y001;
DROP INDEX IF EXISTS idx_telemetry_device_time_curr_y001;
DROP INDEX IF EXISTS idx_telemetry_hour_device;
DROP INDEX IF EXISTS idx_telemetry_day_device;
DROP TABLE IF EXISTS telemetry_history_hour;
DROP TABLE IF EXISTS telemetry_history_day;
DROP FUNCTION IF EXISTS cleanup_telemetry_history();

-- Drop partitions y001..y011 (12 months total incl. current)
DO $$
DECLARE
  i INTEGER;
BEGIN
  FOR i IN 1..11 LOOP
    EXECUTE format('DROP TABLE IF EXISTS telemetry_history_y%I', lpad(i::text, 3, '0'));
  END LOOP;
END $$;

-- Drop current partition explicitly
DROP TABLE IF EXISTS telemetry_history_y001;