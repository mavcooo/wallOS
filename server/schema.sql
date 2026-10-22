-- Schema del micro-servizio di autenticazione locale.
-- Tutto ciò che riguarda credenziali e PIN vive qui, mai nel bundle client.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  password_hash     TEXT,
  role              TEXT NOT NULL CHECK (role IN ('admin', 'family', 'guest', 'kiosk')),
  pin_hash          TEXT NOT NULL,
  pin_length        INTEGER NOT NULL DEFAULT 4 CHECK (pin_length IN (4, 5, 6)),
  is_kiosk_device   INTEGER NOT NULL DEFAULT 0 CHECK (is_kiosk_device IN (0, 1)),
  kiosk_device_id   TEXT UNIQUE,
  allowed_rooms     TEXT,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_access       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_kiosk_device ON users(kiosk_device_id);

-- Refresh token opachi (mai JWT): in DB resta solo lo SHA-256.
-- `family_id` lega una catena di rotazioni: il riuso di un token revocato
-- invalida l'intera famiglia (rilevamento di token theft).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'kiosk')),
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  replaced_by   TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens(expires_at);

-- Tentativi falliti per login, PIN kiosk e PIN azioni protette.
-- La chiave include utente/device (e IP per il login): il blocco è server-side.
CREATE TABLE IF NOT EXISTS auth_attempts (
  key               TEXT PRIMARY KEY,
  failures          INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  locked_until      INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);
