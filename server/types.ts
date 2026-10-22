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
  is_kiosk_device: number;
  kiosk_device_id: string | null;
  allowed_rooms: string | null;
  active: number;
  last_access: string | null;
  created_at: number;
  updated_at: number;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  kind: SessionKind;
  expires_at: number;
  revoked_at: number | null;
  replaced_by: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface AttemptRow {
  key: string;
  failures: number;
  window_started_at: number;
  locked_until: number;
  updated_at: number;
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
  dbPath: string;
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
  seed: SeedConfig;
}
