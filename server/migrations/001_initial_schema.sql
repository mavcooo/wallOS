-- ----------------------------
-- 001_initial_schema.sql - UP
-- ----------------------------
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

-- ----------------------------
-- 001_initial_schema.sql - DOWN
-- ----------------------------
DROP INDEX IF EXISTS idx_refresh_expiry;
DROP INDEX IF EXISTS idx_refresh_user;
DROP INDEX IF EXISTS idx_refresh_family;
DROP TABLE IF EXISTS refresh_tokens;

DROP INDEX IF EXISTS idx_scenarios_order;
DROP TABLE IF EXISTS scenarios;

DROP INDEX IF EXISTS idx_devices_order;
DROP INDEX IF EXISTS idx_devices_type;
DROP INDEX IF EXISTS idx_devices_room;
DROP TABLE IF EXISTS devices;

DROP INDEX IF EXISTS idx_users_kiosk_device;
DROP INDEX IF EXISTS idx_users_role;
DROP TABLE IF EXISTS users;