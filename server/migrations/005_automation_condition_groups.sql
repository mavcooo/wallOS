-- ----------------------------
-- 005_automation_condition_groups.sql - UP
-- ----------------------------
-- Gruppi di condizioni in OR.
--
-- `conditions` resta il primo gruppo (AND logico) e mantiene esattamente il
-- comportamento di prima: una regola senza `condition_groups` si valuta come
-- sempre. `condition_groups` aggiunge gli altri gruppi, anch'essi in AND al
-- loro interno, valutati in **OR** fra loro e con `conditions`:
--
--   conditions       = [ { time_range 23:00→06:00 } ]      → gruppo 1
--   condition_groups = [ [ { user_present true } ],        → gruppo 2
--                         [ { device_state motion ON } ] ] → gruppo 3
--
-- La regola scatta se il gruppo 1 è soddisfatto OPPURE se lo è il gruppo 2
-- OPPURE il gruppo 3. Un gruppo vuoto viene ignorato (non è un "sempre vero"
-- che annullerebbe gli altri); con nessuna condizione e nessun gruppo la
-- regola scatta sempre, come prima.
--
-- Esempio d'uso: "accendi la luce del corridoio fra le 23:00 e le 06:00 se
-- qualcuno è in casa, oppure se il sensore di movimento del corridoio rileva
-- un passaggio, in qualunque orario".

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS condition_groups JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN automations.conditions IS
  'Primo gruppo di condizioni, in AND: time_range, device_state, user_present';
COMMENT ON COLUMN automations.condition_groups IS
  'Altri gruppi di condizioni (AND dentro il gruppo, OR fra i gruppi e con `conditions`)';
COMMENT ON COLUMN automations.actions IS
  'Azioni in sequenza: comandi MQTT ({ type: mqtt, topic, payload, delayMs }) oppure scenari ({ type: scenario, scenarioId, delayMs })';

-- ----------------------------
-- 005_automation_condition_groups.sql - DOWN
-- ----------------------------
ALTER TABLE automations DROP COLUMN IF EXISTS condition_groups;
