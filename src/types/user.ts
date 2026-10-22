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
  lastAccess: string | null;
  pinLength: 4 | 5 | 6;
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
