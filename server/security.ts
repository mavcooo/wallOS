import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  AccessClaims,
  ElevationClaims,
  PublicUser,
  UserRole,
  UserRow,
} from './types.js';

export const ACCESS_COOKIE = 'domus_access';
export const REFRESH_COOKIE = 'domus_refresh';
export const ELEVATION_COOKIE = 'domus_elevation';

const JWT_ISSUER = 'domus-auth';
const JWT_AUDIENCE = 'domus-kiosk';
const JWT_ALGORITHM = 'HS256' as const;

export interface AccessTokenInput {
  userId: string;
  role: UserRole;
  sessionId: string;
  type: AccessClaims['typ'];
  actorId?: string;
  ttlSec: number;
}

export function hashSecret(secret: string, rounds: number): Promise<string> {
  return bcrypt.hash(secret, rounds);
}

export function verifySecret(secret: string, hash: string): Promise<boolean> {
  return bcrypt.compare(secret, hash);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(): string {
  return randomBytes(48).toString('base64url');
}

export function randomId(): string {
  return randomUUID();
}

export function signAccessToken(input: AccessTokenInput, secret: string): string {
  const payload: AccessClaims = {
    sub: input.userId,
    role: input.role,
    typ: input.type,
    sid: input.sessionId,
    ...(input.actorId ? { act: input.actorId } : {}),
  };
  return jwt.sign(payload, secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: input.ttlSec,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

function decodeToken<T extends object>(token: string, secret: string): T | null {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return typeof decoded === 'object' ? (decoded as T) : null;
  } catch {
    return null;
  }
}

export function verifyAccessToken(token: string, secret: string): AccessClaims | null {
  const claims = decodeToken<AccessClaims>(token, secret);
  if (!claims) return null;
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return null;
  if (claims.typ !== 'access' && claims.typ !== 'kiosk' && claims.typ !== 'switch') return null;
  return claims;
}

export function signElevationToken(
  userId: string,
  sessionId: string,
  secret: string,
  ttlSec: number,
): string {
  const payload: ElevationClaims = { sub: userId, sid: sessionId, purpose: 'elevation' };
  return jwt.sign(payload, secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ttlSec,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function verifyElevationToken(
  token: string,
  secret: string,
  userId: string,
  sessionId: string,
): ElevationClaims | null {
  const claims = decodeToken<ElevationClaims>(token, secret);
  if (!claims || claims.purpose !== 'elevation') return null;
  if (claims.sub !== userId || claims.sid !== sessionId) return null;
  return claims;
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const value = request.cookies[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

interface SessionCookieOptions {
  accessToken: string;
  accessTtlSec: number;
  refreshToken?: string;
  refreshTtlSec?: number;
  secure: boolean;
}

export function setSessionCookies(reply: FastifyReply, options: SessionCookieOptions): void {
  const base = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: options.secure,
  };

  reply.setCookie(ACCESS_COOKIE, options.accessToken, {
    ...base,
    path: '/',
    maxAge: options.accessTtlSec,
  });

  if (options.refreshToken && options.refreshTtlSec) {
    reply.setCookie(REFRESH_COOKIE, options.refreshToken, {
      ...base,
      path: '/api/auth',
      maxAge: options.refreshTtlSec,
    });
  }
}

export function setAccessCookie(
  reply: FastifyReply,
  token: string,
  ttlSec: number,
  secure: boolean,
): void {
  reply.setCookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: ttlSec,
  });
}

export function setElevationCookie(
  reply: FastifyReply,
  token: string,
  ttlSec: number,
  secure: boolean,
): void {
  reply.setCookie(ELEVATION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: ttlSec,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  reply.clearCookie(ELEVATION_COOKIE, { path: '/' });
}

export function clearElevationCookie(reply: FastifyReply): void {
  reply.clearCookie(ELEVATION_COOKIE, { path: '/' });
}

export function parseAllowedRooms(raw: unknown): string[] | null {
  if (!raw) return null;
  // `pg` restituisce già l'array per una colonna JSONB; un driver testuale no.
  if (Array.isArray(raw)) {
    return raw.filter((room): room is string => typeof room === 'string');
  }
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((room): room is string => typeof room === 'string');
  } catch {
    return null;
  }
}

export function pinLengthOf(pin: string): 4 | 5 | 6 {
  if (pin.length === 6) return 6;
  if (pin.length === 5) return 5;
  return 4;
}

export function initialsOf(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  return initials || '??';
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.username,
    name: user.display_name,
    initials: initialsOf(user.display_name),
    role: user.role,
    allowedRooms: parseAllowedRooms(user.allowed_rooms),
    active: Boolean(user.active),
    isKioskDevice: Boolean(user.is_kiosk_device),
    kioskDeviceId: user.kiosk_device_id,
    lastAccess: user.last_access,
    pinLength: user.pin_length === 6 ? 6 : user.pin_length === 5 ? 5 : 4,
  };
}
