-- ----------------------------------
-- 003_add_climate_schedules.sql - UP
-- ----------------------------------
-- Cronotermostato settimanale: una riga per fascia oraria e dispositivo.
--
-- Convenzioni:
-- - `day_of_week` 0 = Domenica … 6 = Sabato (stessa numerazione di
--   `Date.getDay()`), così il motore di scheduling non deve rimappare nulla.
-- - `end_time` accetta `24:00`, l'unico modo per esprimere una fascia che
--   arriva a fine giornata (PostgreSQL lo considera valido e maggiore di
--   qualsiasi altro orario). Le fasce non possono scavalcare la mezzanotte:
--   una fascia notturna 22:00 → 06:00 va spezzata in due righe.
-- - `hvac_mode` è il *preset* del cronotermostato (comfort/eco/auto/off), non
--   la modalità del firmware: l'adapter del dispositivo traduce il preset nel
--   payload del broker.

CREATE TABLE IF NOT EXISTS climate_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  target_temp  NUMERIC(4, 1) NOT NULL CHECK (target_temp BETWEEN 5 AND 30),
  hvac_mode    VARCHAR(16) NOT NULL DEFAULT 'auto'
                 CHECK (hvac_mode IN ('comfort', 'eco', 'auto', 'off')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_climate_time_window CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS idx_climate_schedules_lookup
  ON climate_schedules (device_id, day_of_week, is_active);

-- Stato runtime per dispositivo: override manuale, modalità vacanza e ultimo
-- setpoint effettivamente pubblicato (per non ripubblicare ogni minuto).
--
-- - override attivo: `override_target_temp IS NOT NULL` e
--   (`override_until IS NULL` = permanente, oppure `override_until > now()`)
-- - vacanza attiva: `vacation_mode` e (`vacation_until IS NULL` oppure futuro)
-- - `last_sent_*` è una cache del motore, non uno stato di dominio: serve solo
--   a evitare raffiche di comandi identici sul broker.

CREATE TABLE IF NOT EXISTS climate_runtime_states (
  device_id             TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  override_target_temp  NUMERIC(4, 1) CHECK (override_target_temp BETWEEN 5 AND 30),
  override_hvac_mode    VARCHAR(16)
                          CHECK (override_hvac_mode IN ('comfort', 'eco', 'auto', 'off')),
  override_until        TIMESTAMPTZ,
  vacation_mode         BOOLEAN NOT NULL DEFAULT FALSE,
  vacation_until        TIMESTAMPTZ,
  last_sent_target_temp NUMERIC(4, 1),
  last_sent_hvac_mode   VARCHAR(16),
  last_sent_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------
-- 003_add_climate_schedules.sql - DOWN
-- ----------------------------------
DROP INDEX IF EXISTS idx_climate_schedules_lookup;
DROP TABLE IF EXISTS climate_runtime_states;
DROP TABLE IF EXISTS climate_schedules;
