-- --------------------------------
-- 009_security_system.sql - UP
-- --------------------------------
-- Sistema di allarme centralizzato.
--
-- Prima di questa migrazione l'allarme viveva solo nel runtime del pannello
-- (`src/hooks/useMqtt.ts` → toast in memoria): con il tablet spento o l'app
-- ricaricata, un sensore fumo che scattava non lasciava alcuna traccia. Qui lo
-- stato dell'impianto, le zone e il registro degli eventi diventano righe di
-- PostgreSQL, scritte dal worker `alarmManager.ts` che ascolta il broker anche
-- con tutti i browser chiusi.
--
-- Ruoli delle quattro tabelle:
--   security_system_state  → riga singleton (`id = 'primary'`): stato corrente
--                            dell'impianto e chi lo ha armato/disarmato;
--   security_zones         → zone di sicurezza e in quali modalità si armano;
--   security_zone_devices  → mappatura sensore → zona + tipo di evento atteso,
--                            così un PIR in corridoio e un contatto finestra
--                            non producono lo stesso allarme;
--   security_events        → registro append-only: nessun evento viene mai
--                            cancellato, l'acknowledgment e la risoluzione sono
--                            timbri (`acknowledged_at`, `resolved_at`).
--
-- `armed_by`/`disarmed_by` sono UUID perché `users.id` è UUID: la colonna
-- VARCHAR(64) di una prima bozza non avrebbe rispettato la foreign key.

CREATE TABLE IF NOT EXISTS security_system_state (
  id          VARCHAR(32) PRIMARY KEY DEFAULT 'primary',
  -- 'DISARMED' | 'ARMED_HOME' | 'ARMED_AWAY' | 'TRIGGERED'
  status      VARCHAR(32) NOT NULL DEFAULT 'DISARMED',
  armed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  armed_at    TIMESTAMPTZ,
  disarmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  disarmed_at TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT security_system_state_singleton CHECK (id = 'primary'),
  CONSTRAINT security_system_state_status CHECK (
    status IN ('DISARMED', 'ARMED_HOME', 'ARMED_AWAY', 'TRIGGERED')
  )
);

-- Riga unica: `arm`/`disarm` fanno UPDATE, mai INSERT, quindi lo stato non può
-- duplicarsi se due richieste concorrenti arrivano insieme.
INSERT INTO security_system_state (id) VALUES ('primary') ON CONFLICT (id) DO NOTHING;

-- Zone di sicurezza.
--   kind = 'emergency' → sensori 24H (fumo, allagamento, gas, CO): scattano
--                        sempre, anche a impianto disinserito, perché un
--                        principio d'incendio non dipende dall'armamento;
--   kind = 'perimeter' → contatti magnetici su porte e finestre: tipicamente
--                        solo ARMED_AWAY;
--   kind = 'interior'  → volumetrici interni: attivi anche in ARMED_HOME.
-- `arm_home`/`arm_away` sono la policy di default, sovrascrivibile per zona.
CREATE TABLE IF NOT EXISTS security_zones (
  id            VARCHAR(32) PRIMARY KEY,
  name          VARCHAR(64) NOT NULL,
  kind          VARCHAR(16) NOT NULL
                  CHECK (kind IN ('perimeter', 'interior', 'emergency')),
  arm_home      BOOLEAN NOT NULL DEFAULT FALSE,
  arm_away      BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO security_zones (id, name, kind, arm_home, arm_away, display_order) VALUES
  ('emergency', 'Emergenza 24H', 'emergency', TRUE, TRUE, 0),
  ('perimeter', 'Perimetrale', 'perimeter', FALSE, TRUE, 1),
  ('interior', 'Interna', 'interior', TRUE, TRUE, 2)
ON CONFLICT (id) DO NOTHING;

-- Associazione sensore → zona. Un sensore appartiene a una sola zona: il
-- vincolo PRIMARY KEY su `device_id` evita che lo stesso contatto scatti due
-- volte con policy diverse.
CREATE TABLE IF NOT EXISTS security_zone_devices (
  device_id  TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  zone_id    VARCHAR(32) NOT NULL REFERENCES security_zones(id) ON DELETE RESTRICT,
  -- 'smoke' | 'flood' | 'gas' | 'co' | 'motion' | 'contact' | 'tamper' | 'intrusion'
  event_type VARCHAR(32) NOT NULL DEFAULT 'intrusion',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_zone_devices_zone
  ON security_zone_devices (zone_id);

-- Registro persistente degli eventi. Append-only: `resolved_at` marca il
-- rientro, la riga resta per l'audit e per lo storico paginato.
CREATE TABLE IF NOT EXISTS security_events (
  id              BIGSERIAL PRIMARY KEY,
  device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_type      VARCHAR(32) NOT NULL,
  severity        VARCHAR(16) NOT NULL DEFAULT 'critical'
                    CHECK (severity IN ('info', 'warning', 'critical')),
  payload         JSONB,
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  notes           TEXT
);

-- Un solo evento **aperto** per sensore e tipo: due messaggi identici (retained
-- all'avvio, raffica di riconnessione, due worker in rolling update) non
-- duplicano l'allarme. Gli eventi chiusi non sono vincolati: lo stesso sensore
-- può scattare di nuovo domani.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sec_events_one_active
  ON security_events (device_id, event_type) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sec_events_active
  ON security_events (triggered_at DESC) WHERE resolved_at IS NULL;

-- Storico e filtri temporali di `GET /api/security/history`.
CREATE INDEX IF NOT EXISTS idx_sec_events_history
  ON security_events (triggered_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sec_events_device
  ON security_events (device_id, triggered_at DESC);

-- --------------------------------
-- 009_security_system.sql - DOWN
-- --------------------------------
DROP INDEX IF EXISTS idx_sec_events_device;
DROP INDEX IF EXISTS idx_sec_events_history;
DROP INDEX IF EXISTS idx_sec_events_active;
DROP INDEX IF EXISTS idx_sec_events_one_active;
DROP TABLE IF EXISTS security_events;

DROP INDEX IF EXISTS idx_security_zone_devices_zone;
DROP TABLE IF EXISTS security_zone_devices;
DROP TABLE IF EXISTS security_zones;
DROP TABLE IF EXISTS security_system_state;
