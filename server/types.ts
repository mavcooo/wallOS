export type UserRole = 'admin' | 'family' | 'guest' | 'kiosk';

export type SessionKind = 'user' | 'kiosk';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  role: UserRole;
  pin_hash: string;
  pin_length: number;
  is_kiosk_device: boolean;
  kiosk_device_id: string | null;
  allowed_rooms: string[] | null;
  active: boolean;
  last_access: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  kind: SessionKind;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  replaced_by: string | null;
  user_agent: string | null;
  created_at: Date | string;
}

export interface AttemptRow {
  key: string;
  failures: number;
  window_started_at: Date | string;
  locked_until: Date | string | null;
  updated_at: Date | string;
}

export interface RoomRow {
  id: string;
  name: string;
  short_label: string | null;
  icon: string;
  display_order: number;
}

export interface DeviceRow {
  id: string;
  room_id: string;
  name: string;
  type: 'light' | 'climate' | 'power' | 'media' | 'sensor' | 'camera';
  adapter: string;
  model: string | null;
  state_topic: string;
  command_topic: string | null;
  availability_topic: string | null;
  field_map: Record<string, string> | null;
  stream_url: string | null;
  snapshot_url: string | null;
  stream_protocol: 'webrtc' | 'hls' | 'mjpeg' | 'auto' | null;
  aspect_ratio: '16:9' | '4:3' | null;
  metadata: Record<string, unknown>;
  favorite: boolean;
  protected: boolean;
  display_order: number;
}

/** Preset del cronotermostato: non è la modalità del firmware. */
export type ClimatePreset = 'comfort' | 'eco' | 'auto' | 'off';

/** Riga di `climate_schedules`: `NUMERIC` e `TIME` arrivano come stringhe da PG. */
export interface ClimateScheduleRow {
  id: string;
  device_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  target_temp: string | number;
  hvac_mode: string;
  is_active: boolean;
}

/** Riga di `climate_runtime_states`: override, vacanza e ultimo comando. */
export interface ClimateRuntimeRow {
  device_id: string;
  override_target_temp: string | number | null;
  override_hvac_mode: string | null;
  override_until: Date | string | null;
  vacation_mode: boolean;
  vacation_until: Date | string | null;
  last_sent_target_temp: string | number | null;
  last_sent_hvac_mode: string | null;
  last_sent_at: Date | string | null;
  updated_at: Date | string;
}

export interface ScenarioRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  protected: boolean;
  actions: unknown;
  display_order: number;
}

/** Payload JWT: nessun dato sensibile, solo identità e scope. */
export interface AccessClaims {
  sub: string;
  role: UserRole;
  typ: 'access' | 'kiosk' | 'switch';
  /** Famiglia della sessione: lega elevazione e refresh alla stessa catena. */
  sid: string;
  /** Attore originale quando la sessione è un cambio profilo temporaneo. */
  act?: string;
}

export interface ElevationClaims {
  sub: string;
  sid: string;
  purpose: 'elevation';
  exp?: number;
}

/** Profilo restituito al client: mai hash, mai flag interni ambigui. */
export interface PublicUser {
  id: string;
  username: string;
  name: string;
  initials: string;
  role: UserRole;
  /** `null` = tutte le stanze. */
  allowedRooms: string[] | null;
  active: boolean;
  isKioskDevice: boolean;
  /** Identificativo del pannello per l'accesso kiosk (pubblico, non segreto). */
  kioskDeviceId: string | null;
  lastAccess: string | null;
  pinLength: 4 | 5 | 6;
}

export interface PinPolicy {
  minLength: number;
  maxLength: number;
  maxAttempts: number;
  lockoutMs: number;
}

export interface SessionResponse {
  user: PublicUser;
  pinPolicy: PinPolicy;
  elevated: boolean;
  elevatedUntil: number | null;
  temporary: boolean;
}

export interface AttemptPolicy {
  maxAttempts: number;
  lockoutMs: number;
  /** Oltre questa finestra i fallimenti non contano più. */
  windowMs: number;
}

/**
 * Pubblicazione degli eventi di topologia sul broker MQTT condiviso.
 * `url: null` (nessuna variabile impostata) disabilita la pubblicazione.
 */
export interface MqttEventsConfig {
  /** Es. `mqtt://192.168.0.10:1883` (listener TCP del broker). */
  url: string | null;
  username: string | null;
  password: string | null;
  /** Prefisso applicato a tutti i topic, come `MQTT_BASE_TOPIC` sul client. */
  baseTopic: string;
}

export interface SeedConfig {
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminPin: string;
  kioskUsername: string;
  kioskDisplayName: string;
  kioskDeviceId: string;
  kioskPin: string;
}

export interface AuthConfig {
  nodeEnv: string;
  host: string;
  port: number;
  /** URL completa usata dal pool (mai loggata: contiene la password). */
  databaseUrl: string;
  /** Da dove arriva la connessione: `DATABASE_URL` ha la precedenza su `DB_*`. */
  databaseUrlSource: 'DATABASE_URL' | 'DB_*';
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPoolMax: number;
  dbSsl: boolean;
  dbConnectTimeoutMs: number;
  dbIdleTimeoutMs: number;
  jwtSecret: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  corsOrigins: string[];
  accessTtlSec: number;
  refreshTtlSec: number;
  kioskRefreshTtlSec: number;
  elevationTtlSec: number;
  switchTtlSec: number;
  bcryptRounds: number;
  pinPolicy: PinPolicy & { windowMs: number };
  loginPolicy: AttemptPolicy;
  mqtt: MqttEventsConfig;
  seed: SeedConfig;
}
