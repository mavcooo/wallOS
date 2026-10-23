import type { FastifyRequest } from 'fastify';

import type { AuthDb } from './db.js';
import { HttpError } from './http.js';
import {
  ACCESS_COOKIE,
  ELEVATION_COOKIE,
  bearerToken,
  readCookie,
  verifyAccessToken,
  verifyElevationToken,
} from './security.js';
import type { AccessClaims, AuthConfig, UserRow } from './types.js';

export interface AuthContext {
  user: UserRow;
  claims: AccessClaims;
  elevated: boolean;
  elevatedUntil: number | null;
}

export interface AuthDeps {
  db: AuthDb;
  config: AuthConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function elevationState(
  request: FastifyRequest,
  config: AuthConfig,
  userId: string,
  sessionId: string,
): { elevated: boolean; elevatedUntil: number | null } {
  const token = readCookie(request, ELEVATION_COOKIE);
  if (!token) return { elevated: false, elevatedUntil: null };

  const elevation = verifyElevationToken(token, config.jwtSecret, userId, sessionId);
  if (!elevation?.exp) return { elevated: false, elevatedUntil: null };

  return { elevated: true, elevatedUntil: elevation.exp * 1000 };
}

/** Verifica il token di accesso e carica l'utente: nessuna fiducia nel client. */
export async function authenticate(
  request: FastifyRequest,
  deps: AuthDeps,
): Promise<AuthContext> {
  const token = readCookie(request, ACCESS_COOKIE) ?? bearerToken(request);
  if (!token) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente o scaduta');
  }

  const claims = verifyAccessToken(token, deps.config.jwtSecret);
  if (!claims) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione non valida o scaduta');
  }

  const user = await deps.db.findUserById(claims.sub);
  if (!user || !user.active) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Profilo non disponibile');
  }

  return {
    user,
    claims,
    ...elevationState(request, deps.config, user.id, claims.sid),
  };
}

export function requireAuth(deps: AuthDeps) {
  return async (request: FastifyRequest): Promise<void> => {
    request.auth = await authenticate(request, deps);
  };
}

export function requireRole(deps: AuthDeps, roles: readonly UserRow['role'][]) {
  const auth = requireAuth(deps);
  return async (request: FastifyRequest): Promise<void> => {
    await auth(request);
    if (!request.auth || !roles.includes(request.auth.user.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Permessi insufficienti per questa operazione');
    }
  };
}

export async function assertNotLocked(
  db: AuthDb,
  key: string,
  code = 'RATE_LIMITED',
): Promise<void> {
  const retryAfterMs = await db.lockRemaining(key);
  if (retryAfterMs > 0) {
    throw new HttpError(
      429,
      code,
      'Troppi tentativi: riprova più tardi',
      { retryAfterMs },
      { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
    );
  }
}
