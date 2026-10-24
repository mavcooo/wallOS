import type { RoomId } from '@/types/device';

/** Ruoli applicativi decisi dal server (mai da un file compilato nel bundle). */
export type UserRole = 'admin' | 'family' | 'guest' | 'kiosk';

/** Profilo sanitizzato: nessun hash di password/PIN arriva mai al browser. */
export interface SessionUser {
  id: string;
  username: string;
  name: string;
  initials: string;
  role: UserRole;
  /** `null` = tutte le stanze. */
  allowedRooms: RoomId[] | null;
  active: boolean;
  isKioskDevice: boolean;
  kioskDeviceId: string | null;
  lastAccess: string | null;
  pinLength: 4 | 5 | 6;
}

export interface UserCreateInput {
  username: string;
  displayName?: string;
  role: UserRole;
  isKioskDevice: boolean;
  kioskDeviceId?: string | null;
  pin: string;
  password?: string;
}

export interface UserUpdateInput {
  username?: string;
  displayName?: string;
  role?: UserRole;
  isKioskDevice?: boolean;
  kioskDeviceId?: string | null;
  pin?: string;
  password?: string;
  active?: boolean;
}

export interface PinPolicy {
  minLength: number;
  maxLength: number;
  maxAttempts: number;
  lockoutMs: number;
}

export interface SessionEnvelope {
  user: SessionUser;
  pinPolicy: PinPolicy;
  elevated: boolean;
  elevatedUntil: number | null;
  /** Sessione di cambio profilo temporaneo (scade senza revocare il kiosk). */
  temporary: boolean;
}

export interface VerifyPinResult {
  ok: boolean;
  locked: boolean;
  retryAfterMs: number;
  remainingAttempts: number;
  lockedUntil: number | null;
  elevatedUntil?: number;
}
