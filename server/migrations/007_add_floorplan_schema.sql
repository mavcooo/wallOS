-- ----------------------------
-- 007_add_floorplan_schema.sql - UP
-- ----------------------------
-- Planimetria schematica multi-piano.
--
-- Gli ambienti smettono di essere solo un elenco verticale: ogni stanza ha una
-- posizione su una griglia 12×8 (col/row + colSpan/rowSpan) e ogni dispositivo
-- un marker in coordinate percentuali dentro il perimetro della propria stanza.
-- Nessun file CAD né disegno statico: la pianta è generata da questi numeri,
-- quindi è modificabile dal pannello touch (Admin → Planimetria) e vive in
-- PostgreSQL come il resto della topologia.
--
-- `floors` è la tabella dei livelli; `level_order` decide l'ordine del
-- selettore (0 = piano terra, 1 = primo piano, …). `ON DELETE SET NULL` sulle
-- due FK: eliminare un piano non deve mai cancellare stanze o dispositivi, li
-- riporta semplicemente "senza piano" e l'editor li riassegna.

CREATE TABLE IF NOT EXISTS floors (
  id          VARCHAR(64) PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  level_order INTEGER NOT NULL DEFAULT 0,
  icon        VARCHAR(32) DEFAULT 'Layers',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Selettore dei piani: l'indice copre l'unico ordinamento usato dalla UI.
CREATE INDEX IF NOT EXISTS idx_floors_level_order ON floors (level_order);

-- Stanza -> piano. NULL = stanza non ancora assegnata (mostrata nell'editor).
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS floor_id VARCHAR(64) REFERENCES floors(id) ON DELETE SET NULL;

-- Geometria sulla griglia 12×8: coordinate 1-based, span inclusivi.
-- `color` è una chiave semantica (zinc, amber, teal, sky, rose), non un valore
-- CSS: la UI la traduce in classi del tema e l'alto contrasto resta applicabile.
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS grid_layout JSONB NOT NULL
  DEFAULT '{"col": 1, "row": 1, "colSpan": 3, "rowSpan": 2, "color": "zinc"}'::jsonb;

-- Marker del dispositivo dentro la stanza: percentuali 0-100, indipendenti
-- dai pixel del tablet, quindi identiche su ogni pannello della LAN.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS room_pin_position JSONB NOT NULL
  DEFAULT '{"x": 50, "y": 50}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_rooms_floor_id ON rooms (floor_id);

-- Backfill delle installazioni esistenti: i piani demo evitano che tutte le
-- stanze restino fuori dalla pianta dopo l'aggiornamento. Le stanze già
-- assegnate (o riassegnate) non vengono toccate.
INSERT INTO floors (id, name, level_order, icon)
VALUES
  ('piano-terra', 'Piano terra', 0, 'Layers'),
  ('primo-piano', 'Primo piano', 1, 'Building2')
ON CONFLICT (id) DO NOTHING;

UPDATE rooms SET floor_id = 'piano-terra' WHERE floor_id IS NULL;

-- Disposizione iniziale delle stanze del seed (fino a questa migrazione nessuna
-- aveva una geometria: la colonna è appena stata aggiunta). Una casa già
-- personalizzata mantiene i propri id e viene comunque riassegnata dall'editor.
UPDATE rooms SET floor_id = 'primo-piano'
WHERE id IN ('bedroom', 'study', 'bath') AND floor_id = 'piano-terra';

UPDATE rooms SET grid_layout = '{"col": 1, "row": 1, "colSpan": 5, "rowSpan": 4, "color": "amber"}'::jsonb WHERE id = 'living';
UPDATE rooms SET grid_layout = '{"col": 6, "row": 1, "colSpan": 4, "rowSpan": 2, "color": "teal"}'::jsonb WHERE id = 'kitchen';
UPDATE rooms SET grid_layout = '{"col": 6, "row": 3, "colSpan": 4, "rowSpan": 2, "color": "sky"}'::jsonb WHERE id = 'outdoor';
UPDATE rooms SET grid_layout = '{"col": 10, "row": 1, "colSpan": 3, "rowSpan": 2, "color": "zinc"}'::jsonb WHERE id = 'unassigned';
UPDATE rooms SET grid_layout = '{"col": 1, "row": 1, "colSpan": 5, "rowSpan": 3, "color": "rose"}'::jsonb WHERE id = 'bedroom';
UPDATE rooms SET grid_layout = '{"col": 6, "row": 1, "colSpan": 3, "rowSpan": 3, "color": "sky"}'::jsonb WHERE id = 'study';
UPDATE rooms SET grid_layout = '{"col": 9, "row": 1, "colSpan": 4, "rowSpan": 3, "color": "teal"}'::jsonb WHERE id = 'bath';

-- ----------------------------
-- 007_add_floorplan_schema.sql - DOWN
-- ----------------------------
DROP INDEX IF EXISTS idx_rooms_floor_id;

ALTER TABLE devices DROP COLUMN IF EXISTS room_pin_position;
ALTER TABLE rooms DROP COLUMN IF EXISTS grid_layout;
ALTER TABLE rooms DROP COLUMN IF EXISTS floor_id;

DROP INDEX IF EXISTS idx_floors_level_order;
DROP TABLE IF EXISTS floors;

-- ----------------------------
-- 007_add_floorplan_schema.sql - END
-- ----------------------------
