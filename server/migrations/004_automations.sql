-- ----------------------------
-- 004_automations.sql - UP
-- ----------------------------
-- Motore di automazioni domotiche: paradigma Trigger → Conditions → Actions.
--
-- `trigger_config`, `conditions` e `actions` sono JSONB perché la forma cambia
-- con il tipo di trigger e con il tipo di condizione/azione; la validazione
-- stretta la fa Zod nelle route (`server/routes/automations.ts`), così una
-- regola malformata non entra nemmeno nel database.
--
-- Tipi di trigger ammessi:
--   mqtt_state → { "topic": "stat/sensore_soggiorno/MOTION",
--                  "payloadKey": "occupancy", "expectedValue": true }
--   time_cron  → { "cron": "0 23 * * *" }
--   sun_event  → { "event": "sunset", "offsetMinutes": -15 }
--
-- Condizioni (AND logico):
--   [ { "type": "time_range", "start": "23:00", "end": "06:00" },
--     { "type": "device_state", "deviceId": "light_corridoio", "expectedState": "OFF" },
--     { "type": "user_present", "requireHome": true } ]
--
-- Azioni (in sequenza, `delayMs` fra una e l'altra):
--   [ { "topic": "cmnd/light_corridoio/dimmer", "payload": "10", "delayMs": 0 } ]

CREATE TABLE IF NOT EXISTS automations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(128) NOT NULL,
  description       TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  -- 'mqtt_state', 'time_cron', 'sun_event'
  trigger_type      VARCHAR(32) NOT NULL
                      CHECK (trigger_type IN ('mqtt_state', 'time_cron', 'sun_event')),
  trigger_config    JSONB NOT NULL,
  conditions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_triggered_at TIMESTAMPTZ,
  execution_count   INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Elenco delle regole attive per tipo: è la query di caricamento della cache
-- in-memory del motore a ogni riavvio.
CREATE INDEX IF NOT EXISTS idx_automations_active_trigger
  ON automations (is_active, trigger_type);
-- Ricerca del topic dentro `trigger_config`: il motore riscrive le
-- sottoscrizioni MQTT quando la cache viene ricaricata.
CREATE INDEX IF NOT EXISTS idx_automations_trigger_topic
  ON automations USING gin (trigger_config);

CREATE TABLE IF NOT EXISTS automation_logs (
  id                 BIGSERIAL PRIMARY KEY,
  automation_id      UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  triggered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Da dove è partita la valutazione: 'mqtt:<topic>', 'cron:<expr>',
  -- 'sun:<event>' oppure 'test' per l'esecuzione forzata dal pannello.
  trigger_source     TEXT NOT NULL,
  conditions_met     BOOLEAN NOT NULL,
  -- Esito per azione: [{ topic, payload, status, error, durationMs }].
  actions_executed   JSONB,
  -- Latenza totale percepita: dalla ricezione del trigger all'ultimo comando.
  execution_time_ms  INTEGER NOT NULL,
  error_message      TEXT
);

-- Storico per automazione dal più recente: pannello (ultime 10 esecuzioni) e
-- ricerca dell'ultima esecuzione per ogni regola nella lista.
CREATE INDEX IF NOT EXISTS idx_automation_logs_lookup
  ON automation_logs (automation_id, triggered_at DESC);

-- Retention: i log più vecchi di `retention_days` e tutto ciò che supera le
-- `keep_per_automation` righe più recenti per regola (limite rotativo: una
-- automazione che scatta ogni minuto non deve far crescere la tabella senza
-- fine). Idempotente, richiamata in background dal motore.
CREATE OR REPLACE FUNCTION cleanup_automation_logs(
  retention_days INTEGER DEFAULT 90,
  keep_per_automation INTEGER DEFAULT 500
) RETURNS INTEGER AS $$
DECLARE
  removed INTEGER := 0;
BEGIN
  DELETE FROM automation_logs
  WHERE triggered_at < NOW() - make_interval(days => retention_days);
  GET DIAGNOSTICS removed = ROW_COUNT;

  DELETE FROM automation_logs
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
             row_number() OVER (
               PARTITION BY automation_id ORDER BY triggered_at DESC, id DESC
             ) AS position
      FROM automation_logs
    ) ranked
    WHERE position > keep_per_automation
  );

  RETURN removed;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE automations IS 'Regole Trigger → Conditions → Actions del motore di automazioni (cache in-memory in server/services/automationEngine.ts)';
COMMENT ON COLUMN automations.trigger_config IS 'Configurazione del trigger: mqtt_state (topic/payloadKey/expectedValue), time_cron (cron), sun_event (event/offsetMinutes)';
COMMENT ON COLUMN automations.conditions IS 'Condizioni valutate in AND: time_range, device_state, user_present';
COMMENT ON COLUMN automations.actions IS 'Comandi MQTT eseguiti in sequenza: topic, payload, delayMs';
COMMENT ON TABLE automation_logs IS 'Storico esecuzioni: esito condizioni, azioni inviate, latenza totale ed eventuale errore';
COMMENT ON FUNCTION cleanup_automation_logs(INTEGER, INTEGER) IS 'Retention log: più vecchi di retention_days giorni e oltre keep_per_automation righe per regola';

-- ----------------------------
-- 004_automations.sql - DOWN
-- ----------------------------
DROP FUNCTION IF EXISTS cleanup_automation_logs(INTEGER, INTEGER);
DROP TABLE IF EXISTS automation_logs;
DROP TABLE IF EXISTS automations;
