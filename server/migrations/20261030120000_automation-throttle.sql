-- ----------------------------
-- 20261030120000_automation-throttle.sql - UP
-- ----------------------------
-- Finestra di deduplicazione per regola.
--
-- Un sensore di potenza o un PIR pubblica a 1–2 Hz: senza una finestra minima
-- fra due esecuzioni, una raffica di messaggi concorrenti valuta le stesse
-- condizioni prima che la prima azione abbia modificato lo stato (TOCTOU) e
-- comanda due o più volte lo stesso relè. Il motore serializza già le
-- esecuzioni della stessa regola con un `KeyedAsyncLock`
-- (`server/utils/keyedAsyncLock.ts`); questa colonna è la seconda metà della
-- difesa: il cooldown fra l'ultima esecuzione effettiva e la successiva.
--
--   150      → default: sopprime i burst, non le transizioni reali;
--   0        → nessun cooldown (regola che deve reagire a ogni transizione);
--   > 600000 → rifiutato da Zod e limitato dal motore: un comando di sicurezza
--              che arriva dieci minuti dopo il trigger non serve a nulla.
--
-- Il CHECK replica il limite superiore nello schema: un UPDATE manuale o una
-- migrazione futura non possono introdurre un valore che il motore dovrebbe
-- comunque ridurre.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS throttle_ms INTEGER NOT NULL DEFAULT 150;

ALTER TABLE automations
  DROP CONSTRAINT IF EXISTS automations_throttle_ms_range;

ALTER TABLE automations
  ADD CONSTRAINT automations_throttle_ms_range
  CHECK (throttle_ms BETWEEN 0 AND 600000);

COMMENT ON COLUMN automations.throttle_ms IS
  'Finestra minima in ms fra due esecuzioni della stessa regola (0 = nessuna deduplicazione, max 600000)';

-- ----------------------------
-- 20261030120000_automation-throttle.sql - DOWN
-- ----------------------------
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_throttle_ms_range;
ALTER TABLE automations DROP COLUMN IF EXISTS throttle_ms;

-- ----------------------------
-- 20261030120000_automation-throttle.sql - END
-- ----------------------------
