-- Schema PostgreSQL del servizio wallOS.
-- Credenziali, sessioni e topologia della casa vivono nel database, mai nel
-- bundle client. Gli id applicativi (room/device/scenario) restano slug testuali
-- per compatibilità con MQTT e Home Assistant Discovery.

CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  password_hash    TEXT,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'family', 'guest', 'kiosk')),
  pin_hash         TEXT NOT NULL,
  pin_length       SMALLINT NOT NULL DEFAULT 4 CHECK (pin_length IN (4, 5, 6)),
  is_kiosk_device  BOOLEAN NOT NULL DEFAULT FALSE,
  kiosk_device_id  TEXT UNIQUE,
  allowed_rooms    JSONB,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  last_access      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_kiosk_device ON users(kiosk_device_id);

CREATE TABLE IF NOT EXISTS rooms (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  short_label     TEXT,
  icon            TEXT NOT NULL DEFAULT 'home',
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id                  TEXT PRIMARY KEY,
  room_id             TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('light', 'climate', 'power', 'media', 'sensor', 'camera')),
  adapter             TEXT NOT NULL DEFAULT 'custom-json',
  model               TEXT,
  state_topic         TEXT NOT NULL,
  command_topic       TEXT,
  availability_topic  TEXT,
  field_map           JSONB,
  stream_url          TEXT,
  snapshot_url        TEXT,
  stream_protocol     TEXT,
  aspect_ratio        TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  favorite            BOOLEAN NOT NULL DEFAULT FALSE,
  protected           BOOLEAN NOT NULL DEFAULT FALSE,
  display_order       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_room ON devices(room_id);
CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type);
CREATE INDEX IF NOT EXISTS idx_devices_order ON devices(display_order);

-- Migrazione idempotente per database già inizializzati: le colonne camera
-- arrivano anche senza ricreare la tabella, e il CHECK sul tipo viene sostituito
-- per accettare `camera` anche sui volumi esistenti.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stream_url TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snapshot_url TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stream_protocol TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS aspect_ratio TEXT;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_type_check;
ALTER TABLE devices ADD CONSTRAINT devices_type_check
  CHECK (type IN ('light', 'climate', 'power', 'media', 'sensor', 'camera'));

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_stream_protocol_check;
ALTER TABLE devices ADD CONSTRAINT devices_stream_protocol_check
  CHECK (stream_protocol IS NULL OR stream_protocol IN ('webrtc', 'hls', 'mjpeg', 'auto'));

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_aspect_ratio_check;
ALTER TABLE devices ADD CONSTRAINT devices_aspect_ratio_check
  CHECK (aspect_ratio IS NULL OR aspect_ratio IN ('16:9', '4:3'));

CREATE TABLE IF NOT EXISTS scenarios (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  icon           TEXT NOT NULL DEFAULT 'sparkles',
  protected      BOOLEAN NOT NULL DEFAULT FALSE,
  actions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenarios_order ON scenarios(display_order);

-- Refresh token opachi (mai JWT): in DB resta solo lo SHA-256.
-- `family_id` lega una catena di rotazioni: il riuso di un token revocato
-- invalida l'intera famiglia (rilevamento di token theft).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     UUID NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'kiosk')),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  replaced_by   UUID,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens(expires_at);

-- Tentativi falliti per login, PIN kiosk e PIN azioni protette.
-- La chiave include utente/device (e IP per il login): il blocco è server-side.
CREATE TABLE IF NOT EXISTS auth_attempts (
  key               TEXT PRIMARY KEY,
  failures          INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cronotermostato settimanale (vedi migrations/003_add_climate_schedules.sql).
-- `day_of_week` 0 = Domenica … 6 = Sabato, come `Date.getDay()`. `end_time`
-- può valere 24:00 per una fascia che arriva a fine giornata; le fasce non
-- scavalcano la mezzanotte. `hvac_mode` è il preset del cronotermostato, non
-- la modalità del firmware: l'adapter traduce (comfort/eco → riscaldamento).
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

-- Override manuale, vacanza e ultimo setpoint pubblicato per dispositivo.
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

-- Motore di automazioni (vedi migrations/004_automations.sql e
-- migrations/005_automation_condition_groups.sql): Trigger → Conditions →
-- Actions. `trigger_config`, `conditions`, `condition_groups` e `actions` sono
-- JSONB, validati da Zod nelle route; il motore ne tiene una copia in memoria.
CREATE TABLE IF NOT EXISTS automations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(128) NOT NULL,
  description       TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  trigger_type      VARCHAR(32) NOT NULL
                      CHECK (trigger_type IN ('mqtt_state', 'time_cron', 'sun_event')),
  trigger_config    JSONB NOT NULL,
  -- Primo gruppo di condizioni (AND).
  conditions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Altri gruppi: AND dentro il gruppo, OR fra i gruppi.
  condition_groups  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Comandi MQTT e/o scenari, eseguiti in sequenza.
  actions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_triggered_at TIMESTAMPTZ,
  execution_count   INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automations_active_trigger
  ON automations (is_active, trigger_type);
CREATE INDEX IF NOT EXISTS idx_automations_trigger_topic
  ON automations USING gin (trigger_config);

-- Storico esecuzioni: esito, azioni inviate, latenza totale ed errore.
CREATE TABLE IF NOT EXISTS automation_logs (
  id                BIGSERIAL PRIMARY KEY,
  automation_id     UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger_source    TEXT NOT NULL,
  conditions_met    BOOLEAN NOT NULL,
  actions_executed  JSONB,
  execution_time_ms INTEGER NOT NULL,
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_automation_logs_lookup
  ON automation_logs (automation_id, triggered_at DESC);

-- Retention dei log: finestra temporale più limite rotativo per regola.
CREATE OR REPLACE FUNCTION cleanup_automation_logs(
  retention_days INTEGER DEFAULT 90,
  keep_per_automation INTEGER DEFAULT 500
) RETURNS INTEGER AS $$
DECLARE
  removed INTEGER := 0;
BEGIN
  DELETE FROM automation_logs
  WHERE triggered_at < now() - make_interval(days => retention_days);
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

-- ── Display a parete (Kiosk Profiles) ───────────────────────────────────────
-- Vedi migrations/006_kiosk_displays.sql. Le preferenze hardware del tablet
-- (timeout del dimmer, alto contrasto, performance mode, orientamento, stanza
-- iniziale) erano solo nel localStorage del browser; qui diventano server-state,
-- idratate dal pannello e modificabili da Admin -> Display.
CREATE TABLE IF NOT EXISTS kiosk_displays (
  id                      VARCHAR(64) PRIMARY KEY,
  name                    VARCHAR(128) NOT NULL,
  default_room_id         VARCHAR(64) REFERENCES rooms(id) ON DELETE SET NULL,
  dimmer_timeout_sec      INTEGER NOT NULL DEFAULT 120,
  dimmer_screensaver_mode VARCHAR(32) NOT NULL DEFAULT 'clock_float',
  performance_mode        BOOLEAN NOT NULL DEFAULT FALSE,
  high_contrast           BOOLEAN NOT NULL DEFAULT FALSE,
  pin_required            BOOLEAN NOT NULL DEFAULT TRUE,
  screen_orientation      VARCHAR(16) NOT NULL DEFAULT 'landscape',
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kiosk_displays_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CONSTRAINT kiosk_displays_dimmer_range
    CHECK (dimmer_timeout_sec BETWEEN 30 AND 600),
  CONSTRAINT kiosk_displays_screensaver
    CHECK (dimmer_screensaver_mode IN ('clock_float', 'black', 'off')),
  CONSTRAINT kiosk_displays_orientation
    CHECK (screen_orientation IN ('landscape', 'portrait'))
);

CREATE INDEX IF NOT EXISTS idx_kiosk_displays_active ON kiosk_displays (is_active);
CREATE INDEX IF NOT EXISTS idx_kiosk_displays_room ON kiosk_displays (default_room_id);

-- ── Planimetria schematica multi-piano ─────────────────────────────────────
-- Replica di `007_add_floorplan_schema.sql`: `db.init()` applica questo file a
-- ogni avvio e i test usano PGlite senza passare dal runner delle migrazioni,
-- quindi le nuove colonne devono esistere qui come per il resto dello schema.
CREATE TABLE IF NOT EXISTS floors (
  id          VARCHAR(64) PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  level_order INTEGER NOT NULL DEFAULT 0,
  icon        VARCHAR(32) DEFAULT 'Layers',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_floors_level_order ON floors (level_order);

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS floor_id VARCHAR(64) REFERENCES floors(id) ON DELETE SET NULL;
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS grid_layout JSONB NOT NULL
  DEFAULT '{"col": 1, "row": 1, "colSpan": 3, "rowSpan": 2, "color": "zinc"}'::jsonb;
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS room_pin_position JSONB NOT NULL
  DEFAULT '{"x": 50, "y": 50}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_rooms_floor_id ON rooms (floor_id);

-- ── Ledger delle migrazioni ─────────────────────────────────────────────────
-- Non è schema applicativo: è il registro di `server/migrate.ts`, che lo crea
-- da sé (stessa DDL) prima di applicare le migrazioni pendenti. La riga
-- significa "questo file è già stato eseguito": senza, ogni riavvio
-- rieseguirebbe tutte le DDL della cartella `migrations/`.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         SERIAL PRIMARY KEY,
  version    VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
