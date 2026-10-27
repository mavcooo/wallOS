-- ----------------------------
-- 002_add_camera_entity.sql - UP
-- ----------------------------
-- Add camera-specific columns and potentially a dedicated cameras table.
-- Extends the devices table with WebRTC/RTSP/HLS stream metadata.

-- Add camera-specific columns to devices table if not present
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stream_url TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snapshot_url TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stream_protocol TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS aspect_ratio TEXT;

-- Drop and recreate the type check to include 'camera' (already handled in schema.sql,
-- but this ensures migration consistency across environments)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_type_check') THEN
    ALTER TABLE devices DROP CONSTRAINT devices_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_type_check_new') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_type_check
      CHECK (type IN ('light', 'climate', 'power', 'media', 'sensor', 'camera'));
  END IF;
END
$$;

-- Add a dedicated cameras table for WebRTC/RTSP/HLS metadata
CREATE TABLE IF NOT EXISTS cameras (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id           TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  stream_type         TEXT NOT NULL CHECK (stream_type IN ('webrtc', 'rtsp', 'hls')),
  rtsp_url            TEXT,
  webrtc_offer        TEXT,
  webrtc_answer       TEXT,
  hls_playlist_url    TEXT,
  max_bitrate         INTEGER DEFAULT 1500,
  keyframe_interval   INTEGER DEFAULT 2,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cameras_device ON cameras(device_id);
CREATE INDEX IF NOT EXISTS idx_cameras_stream_type ON cameras(stream_type);

-- Corrispondenza device ↔ cameras: resta a livello applicativo.
-- La vecchia regola `camera_insert_rule` reindirizzava l'INSERT di un device
-- `camera` di nuovo su `devices`, quindi si auto-invocava: qualunque
-- inserimento di una telecamera falliva con
-- `infinite recursion detected in rules for relation "devices"` (seed compreso).
-- La si elimina anche sui database dove era già stata creata.
DROP RULE IF EXISTS camera_insert_rule ON devices;

-- Update scenarios/rows comment for camera support documentation
COMMENT ON TABLE cameras IS 'Metadati e configurazione stream per dispositivi di tipo camera (WebRTC/RTSP/HLS)';
COMMENT ON COLUMN cameras.stream_type IS 'Tipo di stream: webrtc, rtsp o hls';
COMMENT ON COLUMN cameras.rtsp_url IS 'URL RTSP per lo stream (se applicable)';
COMMENT ON COLUMN cameras.webrtc_offer IS 'SDP offer WebRTC (se applicable)';
COMMENT ON COLUMN cameras.webrtc_answer IS 'SDP answer WebRTC (se applicable)';
COMMENT ON COLUMN cameras.hls_playlist_url IS 'URL playlist HLS (se applicable)';

-- ----------------------------
-- 002_add_camera_entity.sql - DOWN
-- ----------------------------
DROP INDEX IF EXISTS idx_cameras_stream_type;
DROP INDEX IF EXISTS idx_cameras_device;
DROP TABLE IF EXISTS cameras;

DROP RULE IF EXISTS camera_insert_rule ON devices;

-- Revert the type check constraint to exclude 'camera' (original state)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_type_check_new') THEN
    ALTER TABLE devices DROP CONSTRAINT devices_type_check_new;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_type_check') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_type_check
      CHECK (type IN ('light', 'climate', 'power', 'media', 'sensor'));
  END IF;
END
$$;

-- Remove the added camera columns from devices
ALTER TABLE devices DROP COLUMN IF EXISTS stream_url;
ALTER TABLE devices DROP COLUMN IF EXISTS snapshot_url;
ALTER TABLE devices DROP COLUMN IF EXISTS stream_protocol;
ALTER TABLE devices DROP COLUMN IF EXISTS aspect_ratio;