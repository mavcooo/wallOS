-- ----------------------------
-- 008_add_db_health_checks.sql - UP
-- ----------------------------
-- Audit dei controlli di connettività verso PostgreSQL.
--
-- Fino a qui `checkDatabaseHealth()` eseguiva solo una query volatile: la
-- latenza e gli errori esistevano per la durata della risposta HTTP e nessuno
-- poteva ricostruire un'interruzione passata. Ogni esito viene ora salvato qui
-- (status, latenza e messaggio d'errore senza credenziali) e il pannello di
-- diagnostica lo legge con `GET /api/database/history`.
--
-- `status`:
--   'healthy'  → query riuscita entro la soglia di latenza;
--   'degraded' → query riuscita ma lenta (DB sotto carico o rete instabile);
--   'down'     → query fallita o timeout.
-- Un DB irraggiungibile non può ovviamente registrare la propria riga: lo
-- storico mostra l'ultimo stato salvato e il pannello segnala la disconnessione.

CREATE TABLE IF NOT EXISTS db_health_checks (
  id            BIGSERIAL PRIMARY KEY,
  status        VARCHAR(16) NOT NULL,
  latency_ms    INTEGER NOT NULL,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_message TEXT,

  CONSTRAINT db_health_checks_status
    CHECK (status IN ('healthy', 'degraded', 'down')),
  CONSTRAINT db_health_checks_latency
    CHECK (latency_ms >= 0)
);

-- La lista di diagnostica legge sempre "i più recenti": indice decrescente.
CREATE INDEX IF NOT EXISTS idx_db_checks_time ON db_health_checks (checked_at DESC);

-- ----------------------------
-- 008_add_db_health_checks.sql - DOWN
-- ----------------------------
DROP INDEX IF EXISTS idx_db_checks_time;
DROP TABLE IF EXISTS db_health_checks;
