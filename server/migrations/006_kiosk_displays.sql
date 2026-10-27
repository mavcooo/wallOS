-- ----------------------------
-- 006_kiosk_displays.sql - UP
-- ----------------------------
-- Profili dei tablet a parete (Kiosk Profiles).
--
-- Fino a qui le preferenze hardware del pannello (timeout del dimmer, alto
-- contrasto, performance mode, orientamento, stanza iniziale) vivevano solo nel
-- localStorage del browser: un riavvio in incognito, una cache svuotata o un
-- tablet sostituito le azzerava, e l'amministratore non poteva correggerle da
-- desktop. Qui diventano server-state: la riga è la configurazione del display,
-- il pannello la idrata all'avvio (`GET /api/kiosk/:id`) e l'amministratore la
-- modifica da Admin → Display, con notifica MQTT immediata.
--
-- `id` è il `wallos_kiosk_id` del pannello (cookie decennale + localStorage):
-- un UUID `kiosk_…` generato al primo avvio oppure un nome scelto
-- dall'amministratore (`tablet_ingresso`, `pannello_cucina`).

CREATE TABLE IF NOT EXISTS kiosk_displays (
  id                      VARCHAR(64) PRIMARY KEY,
  name                    VARCHAR(128) NOT NULL,
  default_room_id         VARCHAR(64) REFERENCES rooms(id) ON DELETE SET NULL,
  -- Timeout di `useKioskDimmer`: lo stesso valore di `ui.dimmerTimeoutMs`.
  dimmer_timeout_sec      INTEGER NOT NULL DEFAULT 120,
  -- `clock_float` (orologio che fluttua), `black` (nero pieno) o `off`.
  dimmer_screensaver_mode VARCHAR(32) NOT NULL DEFAULT 'clock_float',
  -- Disattiva blur, ombre e animazioni per i pannelli con GPU debole.
  performance_mode        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Modalità luce solare (WCAG AAA): `data-contrast="more"` sul documento.
  high_contrast           BOOLEAN NOT NULL DEFAULT FALSE,
  -- PIN richiesto per le azioni sensibili (device protetti, broker, utenti).
  pin_required            BOOLEAN NOT NULL DEFAULT TRUE,
  screen_orientation      VARCHAR(16) NOT NULL DEFAULT 'landscape',
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  -- Ultimo contatto: `GET /api/kiosk/:id` lo riscrive a ogni idratazione.
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

-- Elenco admin: solo i display attivi interessano, l'indice copre il filtro.
CREATE INDEX IF NOT EXISTS idx_kiosk_displays_active ON kiosk_displays (is_active);

-- La FK punta a `rooms`: eliminare una stanza non deve cancellare il display,
-- solo riportarlo alla vista Overview (default_room_id NULL).
CREATE INDEX IF NOT EXISTS idx_kiosk_displays_room ON kiosk_displays (default_room_id);

-- ----------------------------
-- 006_kiosk_displays.sql - DOWN
-- ----------------------------
DROP TABLE IF EXISTS kiosk_displays;
