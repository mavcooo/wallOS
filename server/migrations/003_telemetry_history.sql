-- ----------------------------
-- 003_telemetry_history.sql - UP
-- ----------------------------
-- Campioni grezzi (ogni 5-15 min) + aggregati orari e giornalieri precalcolati
-- per i grafici 24h/7d/30d.
--
-- `telemetry_history` è l'unica tabella grezza letta e scritta
-- dall'applicazione (`server/routes/telemetry.ts`, `server/services/telemetryWorker.ts`):
-- tabella singola con indici mirati, nessuna partizione da creare mese per
-- mese, così un inserimento non può fallire perché manca la partizione del
-- mese corrente. La retention resta a carico di `cleanup_telemetry_history()`.

CREATE TABLE IF NOT EXISTS telemetry_history (
  id BIGSERIAL PRIMARY KEY,
  -- `devices.id` è TEXT: stesso tipo anche qui, altrimenti la foreign key
  -- richiederebbe una conversione implicita a ogni inserimento.
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  metric_type VARCHAR(32) NOT NULL, -- 'power_watts', 'energy_kwh', 'temperature', 'humidity'
  val NUMERIC(10, 2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serie per device+metrica dalla più recente: copre le query filtrate del
-- grafico e dell'aggregazione.
CREATE INDEX IF NOT EXISTS idx_telemetry_history_device_time
  ON telemetry_history (device_id, metric_type, recorded_at DESC);
-- Finestra temporale senza filtro di device: query "tutta la casa" e retention.
CREATE INDEX IF NOT EXISTS idx_telemetry_history_recorded_at
  ON telemetry_history (recorded_at);

-- Aggregati orari: min/max/media per device+metrica.
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
CREATE INDEX IF NOT EXISTS idx_telemetry_hour_device
  ON telemetry_history_hour (device_id, metric_type, bucket DESC);

-- Aggregati giornalieri: min/max/media e totale energia (kWh).
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
CREATE INDEX IF NOT EXISTS idx_telemetry_day_device
  ON telemetry_history_day (device_id, metric_type, bucket DESC);

-- Retention: campioni grezzi 30 giorni, aggregati orari 14 giorni, giornalieri
-- 30 giorni. Da richiamare periodicamente (cron o task SQL), è idempotente e
-- non tocca le righe dentro la finestra.
CREATE OR REPLACE FUNCTION cleanup_telemetry_history() RETURNS INTEGER AS $$
DECLARE
  removed INTEGER := 0;
BEGIN
  DELETE FROM telemetry_history
  WHERE recorded_at < NOW() - interval '30 day';
  GET DIAGNOSTICS removed = ROW_COUNT;

  DELETE FROM telemetry_history_hour
  WHERE bucket < date_trunc('day', NOW()) - interval '14 day';

  DELETE FROM telemetry_history_day
  WHERE bucket < date_trunc('day', NOW()) - interval '30 day';

  RETURN removed;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE telemetry_history IS 'Raw telemetry samples (5-15 min): engine-side history + charts, 30-day retention';
COMMENT ON COLUMN telemetry_history.metric_type IS 'power_watts | energy_kwh | temperature | humidity';
COMMENT ON INDEX idx_telemetry_history_device_time IS 'Index on (device_id, metric_type, recorded_at DESC) for history queries';
COMMENT ON FUNCTION cleanup_telemetry_history() IS 'Retention: raw samples older than 30 days, hourly aggregates older than 14 days, daily aggregates older than 30 days';

-- ----------------------------
-- 003_telemetry_history.sql - DOWN
-- ----------------------------
DROP FUNCTION IF EXISTS cleanup_telemetry_history();
DROP TABLE IF EXISTS telemetry_history;
DROP TABLE IF EXISTS telemetry_history_hour;
DROP TABLE IF EXISTS telemetry_history_day;
