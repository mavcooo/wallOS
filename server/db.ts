import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type {
  AttemptPolicy,
  AttemptRow,
  RefreshTokenRow,
  UserRole,
  UserRow,
} from './types.js';

export interface NewUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  role: UserRole;
  pinHash: string;
  pinLength: 4 | 5 | 6;
  isKioskDevice: boolean;
  kioskDeviceId: string | null;
  allowedRooms: string[] | null;
}

export interface NewRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  kind: 'user' | 'kiosk';
  expiresAt: number;
  userAgent: string | null;
}

export interface FailureResult {
  /** Fallimenti nella finestra corrente; 0 se è scattato il lockout. */
  failures: number;
  lockedUntil: number;
}

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * Accesso sincrono a SQLite (better-sqlite3): nel contesto embedded del
 * gateway le query sono microsecondi e non serve un pool async.
 */
export class AuthDb {
  readonly raw: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.raw = new Database(path);
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
  }

  close(): void {
    this.raw.close();
  }

  findUserById(id: string): UserRow | undefined {
    return this.raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  findUserByUsername(username: string): UserRow | undefined {
    return this.raw
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username.toLowerCase()) as UserRow | undefined;
  }

  findKioskByDeviceId(deviceId: string): UserRow | undefined {
    return this.raw
      .prepare('SELECT * FROM users WHERE kiosk_device_id = ? AND is_kiosk_device = 1')
      .get(deviceId) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.raw
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all() as UserRow[];
  }

  insertUser(user: NewUser): void {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO users (
           id, username, display_name, password_hash, role, pin_hash, pin_length,
           is_kiosk_device, kiosk_device_id, allowed_rooms, active, last_access,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(
        user.id,
        user.username.toLowerCase(),
        user.displayName,
        user.passwordHash,
        user.role,
        user.pinHash,
        user.pinLength,
        user.isKioskDevice ? 1 : 0,
        user.kioskDeviceId,
        user.allowedRooms === null ? null : JSON.stringify(user.allowedRooms),
        now,
        now,
      );
  }

  setUserActive(id: string, active: boolean): void {
    this.raw
      .prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?')
      .run(active ? 1 : 0, Date.now(), id);
  }

  updateUserPin(id: string, pinHash: string, pinLength: 4 | 5 | 6): void {
    this.raw
      .prepare('UPDATE users SET pin_hash = ?, pin_length = ?, updated_at = ? WHERE id = ?')
      .run(pinHash, pinLength, Date.now(), id);
  }

  markAccess(id: string, label: string): void {
    this.raw
      .prepare('UPDATE users SET last_access = ?, updated_at = ? WHERE id = ?')
      .run(label, Date.now(), id);
  }

  createRefreshToken(token: NewRefreshToken): void {
    this.raw
      .prepare(
        `INSERT INTO refresh_tokens (
           id, user_id, family_id, token_hash, kind, expires_at,
           revoked_at, replaced_by, user_agent, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        token.id,
        token.userId,
        token.familyId,
        token.tokenHash,
        token.kind,
        token.expiresAt,
        token.userAgent,
        Date.now(),
      );
  }

  findRefreshTokenByHash(tokenHash: string): RefreshTokenRow | undefined {
    return this.raw
      .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
      .get(tokenHash) as RefreshTokenRow | undefined;
  }

  revokeRefreshToken(id: string, replacedBy: string | null = null): void {
    this.raw
      .prepare(
        'UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .run(Date.now(), replacedBy, id);
  }

  revokeRefreshFamily(familyId: string): void {
    this.raw
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
      .run(Date.now(), familyId);
  }

  revokeUserRefreshTokens(userId: string, exceptId?: string): void {
    if (exceptId) {
      this.raw
        .prepare(
          'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL',
        )
        .run(Date.now(), userId, exceptId);
      return;
    }
    this.raw
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), userId);
  }

  purgeExpiredRefreshTokens(now = Date.now()): void {
    this.raw.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now);
  }

  lockRemaining(key: string, now = Date.now()): number {
    const row = this.raw
      .prepare('SELECT * FROM auth_attempts WHERE key = ?')
      .get(key) as AttemptRow | undefined;
    return row && row.locked_until > now ? row.locked_until - now : 0;
  }

  /** Registra un fallimento e applica il lockout quando si raggiunge la soglia. */
  recordFailure(key: string, policy: AttemptPolicy, now = Date.now()): FailureResult {
    const row = this.raw
      .prepare('SELECT * FROM auth_attempts WHERE key = ?')
      .get(key) as AttemptRow | undefined;

    const withinWindow = row !== undefined && now - row.window_started_at <= policy.windowMs;
    let failures = withinWindow ? row.failures + 1 : 1;
    let windowStartedAt = withinWindow ? row.window_started_at : now;
    let lockedUntil = 0;

    if (failures >= policy.maxAttempts) {
      lockedUntil = now + policy.lockoutMs;
      // Dopo il lockout si riparte con un contatore pulito.
      failures = 0;
      windowStartedAt = now;
    }

    this.raw
      .prepare(
        `INSERT INTO auth_attempts (key, failures, window_started_at, locked_until, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           failures = excluded.failures,
           window_started_at = excluded.window_started_at,
           locked_until = excluded.locked_until,
           updated_at = excluded.updated_at`,
      )
      .run(key, failures, windowStartedAt, lockedUntil, now);

    return { failures, lockedUntil };
  }

  clearFailures(key: string): void {
    this.raw.prepare('DELETE FROM auth_attempts WHERE key = ?').run(key);
  }
}
