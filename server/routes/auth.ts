import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { timestampMs, type AuthDb } from '../db.js';
import { HttpError, asRecord, readDigits, readSecret, readString } from '../http.js';
import {
  REFRESH_COOKIE,
  clearElevationCookie,
  clearSessionCookies,
  hashSecret,
  hashToken,
  randomId,
  randomToken,
  pinLengthOf,
  readCookie,
  setAccessCookie,
  setElevationCookie,
  setSessionCookies,
  signAccessToken,
  signElevationToken,
  toPublicUser,
  verifySecret,
} from '../security.js';
import { assertNotLocked, elevationState, requireAuth } from '../session.js';
import type {
  AuthConfig,
  PublicUser,
  SessionKind,
  SessionResponse,
  UserRow,
} from '../types.js';

export interface AuthRouteDeps {
  db: AuthDb;
  config: AuthConfig;
  /** Hash di confronto per non rivelare via timing se un username esiste. */
  dummyPasswordHash: string;
}

function pinPolicy(config: AuthConfig): SessionResponse['pinPolicy'] {
  return {
    minLength: config.pinPolicy.minLength,
    maxLength: config.pinPolicy.maxLength,
    maxAttempts: config.pinPolicy.maxAttempts,
    lockoutMs: config.pinPolicy.lockoutMs,
  };
}

function sessionResponse(
  user: UserRow,
  config: AuthConfig,
  options: { elevated?: boolean; elevatedUntil?: number | null; temporary?: boolean } = {},
): SessionResponse {
  return {
    user: toPublicUser(user),
    pinPolicy: pinPolicy(config),
    elevated: options.elevated ?? false,
    elevatedUntil: options.elevatedUntil ?? null,
    temporary: options.temporary ?? false,
  };
}

function userAgentOf(request: FastifyRequest): string | null {
  const agent = request.headers['user-agent'];
  return typeof agent === 'string' ? agent.slice(0, 256) : null;
}

async function createRefreshToken(
  db: AuthDb,
  config: AuthConfig,
  user: UserRow,
  kind: SessionKind,
  familyId: string,
  userAgent: string | null,
): Promise<{ token: string; id: string; ttlSec: number }> {
  const token = randomToken();
  const id = randomId();
  const ttlSec =
    kind === 'kiosk' ? config.kioskRefreshTtlSec : config.refreshTtlSec;

  await db.createRefreshToken({
    id,
    userId: user.id,
    familyId,
    tokenHash: hashToken(token),
    kind,
    expiresAt: Date.now() + ttlSec * 1000,
    userAgent,
  });

  return { token, id, ttlSec };
}

async function issueSession(
  db: AuthDb,
  config: AuthConfig,
  reply: FastifyReply,
  user: UserRow,
  kind: SessionKind,
  userAgent: string | null,
  familyId = randomId(),
): Promise<string> {
  const refresh = await createRefreshToken(db, config, user, kind, familyId, userAgent);
  const accessToken = signAccessToken(
    {
      userId: user.id,
      role: user.role,
      sessionId: familyId,
      type: kind === 'kiosk' ? 'kiosk' : 'access',
      ttlSec: config.accessTtlSec,
    },
    config.jwtSecret,
  );

  setSessionCookies(reply, {
    accessToken,
    accessTtlSec: config.accessTtlSec,
    refreshToken: refresh.token,
    refreshTtlSec: refresh.ttlSec,
    secure: config.cookieSecure,
  });

  return familyId;
}

function pinAttemptKey(userId: string): string {
  return `pin:${userId}`;
}

function assertPinDigits(pin: string, config: AuthConfig, field = 'pin'): string {
  const { minLength, maxLength } = config.pinPolicy;
  if (pin.length < minLength || pin.length > maxLength) {
    throw new HttpError(
      400,
      'INVALID_PIN_FORMAT',
      `Il PIN deve contenere da ${minLength} a ${maxLength} cifre`,
      { field },
    );
  }
  return pin;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, config } = deps;

  app.post('/api/auth/login', async (request, reply) => {
    const body = asRecord(request.body);
    const username = readString(body, 'username', 64)?.toLowerCase() ?? null;
    const password = readSecret(body, 'password', 72);
    if (!username || !password) {
      throw new HttpError(400, 'INVALID_BODY', 'Username e password sono obbligatori');
    }

    const attemptKey = `login:${username}:${request.ip}`;
    await assertNotLocked(db, attemptKey);

    const user = await db.findUserByUsername(username);
    const hash = user?.password_hash ?? deps.dummyPasswordHash;
    const valid = await verifySecret(password, hash);

    if (!user || !valid) {
      const failure = await db.recordFailure(attemptKey, config.loginPolicy);
      if (failure.lockedUntil > 0) {
        throw new HttpError(
          429,
          'LOGIN_LOCKED',
          'Troppi tentativi: accesso temporaneamente bloccato',
          { retryAfterMs: failure.lockedUntil - Date.now() },
          { 'Retry-After': String(Math.ceil(config.loginPolicy.lockoutMs / 1000)) },
        );
      }
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Credenziali non valide', {
        remainingAttempts: config.loginPolicy.maxAttempts - failure.failures,
      });
    }

    if (!user.active) {
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'Profilo disattivato');
    }

    await db.clearFailures(attemptKey);
    await db.markAccess(user.id, 'Sessione attiva');
    await issueSession(db, config, reply, user, 'user', userAgentOf(request));

    const fresh = (await db.findUserById(user.id)) ?? user;
    return reply.send(sessionResponse(fresh, config));
  });

  app.post('/api/auth/kiosk-session', async (request, reply) => {
    const body = asRecord(request.body);
    const deviceId = readString(body, 'deviceId', 128);
    const pin = readDigits(body, 'pin');
    if (!deviceId || !pin) {
      throw new HttpError(400, 'INVALID_BODY', 'deviceId e PIN sono obbligatori');
    }

    const attemptKey = `kiosk-pin:${deviceId.toLowerCase()}`;
    await assertNotLocked(db, attemptKey, 'PIN_LOCKED');

    const user = await db.findKioskByDeviceId(deviceId);
    const hash = user?.pin_hash ?? deps.dummyPasswordHash;
    const valid = await verifySecret(pin, hash);

    if (!user || !valid || !user.active) {
      const failure = await db.recordFailure(attemptKey, config.pinPolicy);
      if (failure.lockedUntil > 0) {
        throw new HttpError(
          429,
          'PIN_LOCKED',
          'Troppi tentativi: dispositivo bloccato temporaneamente',
          { retryAfterMs: failure.lockedUntil - Date.now() },
          { 'Retry-After': String(Math.ceil(config.pinPolicy.lockoutMs / 1000)) },
        );
      }
      throw new HttpError(401, 'INVALID_KIOSK_PIN', 'Dispositivo o PIN non validi', {
        remainingAttempts: config.pinPolicy.maxAttempts - failure.failures,
      });
    }

    await db.clearFailures(attemptKey);
    await db.markAccess(user.id, 'Kiosk collegato');
    await issueSession(db, config, reply, user, 'kiosk', userAgentOf(request));

    const fresh = (await db.findUserById(user.id)) ?? user;
    return reply.send(sessionResponse(fresh, config));
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const token = readCookie(request, REFRESH_COOKIE);
    if (!token) throw new HttpError(401, 'NO_REFRESH', 'Refresh token assente');

    const row = await db.findRefreshTokenByHash(hashToken(token));
    if (!row) throw new HttpError(401, 'INVALID_REFRESH', 'Refresh token non valido');

    if (timestampMs(row.expires_at) <= Date.now()) {
      await db.revokeRefreshToken(row.id);
      throw new HttpError(401, 'EXPIRED_REFRESH', 'Sessione scaduta');
    }

    // Un token già ruotato che riappare indica un furto: si brucia la famiglia.
    if (row.revoked_at !== null) {
      await db.revokeRefreshFamily(row.family_id);
      throw new HttpError(401, 'REFRESH_REUSED', 'Sessione revocata');
    }

    const user = await db.findUserById(row.user_id);
    if (!user || !user.active) {
      await db.revokeRefreshFamily(row.family_id);
      throw new HttpError(401, 'ACCOUNT_UNAVAILABLE', 'Profilo non disponibile');
    }

    const next = await createRefreshToken(
      db,
      config,
      user,
      row.kind,
      row.family_id,
      userAgentOf(request),
    );
    await db.revokeRefreshToken(row.id, next.id);

    const accessToken = signAccessToken(
      {
        userId: user.id,
        role: user.role,
        sessionId: row.family_id,
        type: row.kind === 'kiosk' ? 'kiosk' : 'access',
        ttlSec: config.accessTtlSec,
      },
      config.jwtSecret,
    );

    setSessionCookies(reply, {
      accessToken,
      accessTtlSec: config.accessTtlSec,
      refreshToken: next.token,
      refreshTtlSec: next.ttlSec,
      secure: config.cookieSecure,
    });

    const elevation = elevationState(request, config, user.id, row.family_id);
    return reply.send(sessionResponse(user, config, elevation));
  });

  app.get(
    '/api/auth/me',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');
      return reply.send(
        sessionResponse(auth.user, config, {
          elevated: auth.elevated,
          elevatedUntil: auth.elevatedUntil,
          temporary: typeof auth.claims.act === 'string',
        }),
      );
    },
  );

  app.post(
    '/api/auth/logout',
    async (request, reply) => {
      const token = readCookie(request, REFRESH_COOKIE);
      if (token) {
        const row = await db.findRefreshTokenByHash(hashToken(token));
        if (row) await db.revokeRefreshFamily(row.family_id);
      }
      clearSessionCookies(reply);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/auth/verify-pin',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');

      const body = asRecord(request.body);
      const pin = readDigits(body, 'pin');
      if (!pin) throw new HttpError(400, 'INVALID_BODY', 'PIN obbligatorio');

      const attemptKey = pinAttemptKey(auth.user.id);
      const retryAfterMs = await db.lockRemaining(attemptKey);
      if (retryAfterMs > 0) {
        return {
          ok: false,
          locked: true,
          retryAfterMs,
          remainingAttempts: 0,
          lockedUntil: Date.now() + retryAfterMs,
        };
      }

      const valid = await verifySecret(pin, auth.user.pin_hash);
      if (!valid) {
        const failure = await db.recordFailure(attemptKey, config.pinPolicy);
        const locked = failure.lockedUntil > 0;
        return {
          ok: false,
          locked,
          retryAfterMs: locked ? failure.lockedUntil - Date.now() : 0,
          remainingAttempts: locked
            ? 0
            : Math.max(0, config.pinPolicy.maxAttempts - failure.failures),
          lockedUntil: locked ? failure.lockedUntil : null,
        };
      }

      await db.clearFailures(attemptKey);
      const elevatedUntil = Date.now() + config.elevationTtlSec * 1000;
      const elevationToken = signElevationToken(
        auth.user.id,
        auth.claims.sid,
        config.jwtSecret,
        config.elevationTtlSec,
      );
      setElevationCookie(reply, elevationToken, config.elevationTtlSec, config.cookieSecure);

      return {
        ok: true,
        locked: false,
        retryAfterMs: 0,
        remainingAttempts: config.pinPolicy.maxAttempts,
        lockedUntil: null,
        elevatedUntil,
      };
    },
  );

  app.post(
    '/api/auth/pin',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');

      const body = asRecord(request.body);
      const newPin = readDigits(body, 'newPin');
      if (!newPin) throw new HttpError(400, 'INVALID_BODY', 'Nuovo PIN obbligatorio');
      assertPinDigits(newPin, config, 'newPin');

      if (!auth.elevated) {
        const currentPin = readDigits(body, 'currentPin');
        if (!currentPin) {
          throw new HttpError(
            403,
            'ELEVATION_REQUIRED',
            'Verifica il PIN corrente prima di cambiarlo',
          );
        }

        const attemptKey = pinAttemptKey(auth.user.id);
        await assertNotLocked(db, attemptKey, 'PIN_LOCKED');
        const validCurrent = await verifySecret(currentPin, auth.user.pin_hash);
        if (!validCurrent) {
          const failure = await db.recordFailure(attemptKey, config.pinPolicy);
          throw new HttpError(
            400,
            'INVALID_PIN',
            'PIN corrente non valido',
            failure.lockedUntil > 0
              ? { retryAfterMs: failure.lockedUntil - Date.now(), remainingAttempts: 0 }
              : { remainingAttempts: config.pinPolicy.maxAttempts - failure.failures },
          );
        }
        await db.clearFailures(attemptKey);
      }

      if (await verifySecret(newPin, auth.user.pin_hash)) {
        throw new HttpError(400, 'PIN_UNCHANGED', 'Il nuovo PIN coincide con quello attuale');
      }

      await db.updateUserPin(
        auth.user.id,
        await hashSecret(newPin, config.bcryptRounds),
        pinLengthOf(newPin),
      );
      await db.clearFailures(pinAttemptKey(auth.user.id));

      // Le altre sessioni del profilo decadono; quella corrente resta valida.
      const refreshToken = readCookie(request, REFRESH_COOKIE);
      const current = refreshToken
        ? await db.findRefreshTokenByHash(hashToken(refreshToken))
        : undefined;
      await db.revokeUserRefreshTokens(auth.user.id, current?.id);

      clearElevationCookie(reply);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/auth/switch-profile',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');

      const body = asRecord(request.body);
      const userId = readString(body, 'userId', 128);
      const pin = readDigits(body, 'pin');
      if (!userId || !pin) {
        throw new HttpError(400, 'INVALID_BODY', 'userId e PIN sono obbligatori');
      }

      const attemptKey = pinAttemptKey(auth.user.id);
      await assertNotLocked(db, attemptKey, 'PIN_LOCKED');
      const valid = await verifySecret(pin, auth.user.pin_hash);
      if (!valid) {
        const failure = await db.recordFailure(attemptKey, config.pinPolicy);
        throw new HttpError(
          403,
          'INVALID_PIN',
          'PIN non valido',
          failure.lockedUntil > 0
            ? { retryAfterMs: failure.lockedUntil - Date.now(), remainingAttempts: 0 }
            : { remainingAttempts: config.pinPolicy.maxAttempts - failure.failures },
        );
      }
      await db.clearFailures(attemptKey);

      const target = await db.findUserById(userId);
      if (!target || !target.active) {
        throw new HttpError(404, 'USER_NOT_FOUND', 'Profilo non disponibile');
      }
      if (target.id === auth.user.id) {
        throw new HttpError(400, 'SAME_PROFILE', 'Il profilo è già attivo');
      }

      const allowed =
        auth.user.role === 'admin' ||
        (auth.user.role === 'kiosk' && (target.role === 'family' || target.role === 'guest'));
      if (!allowed) {
        throw new HttpError(403, 'FORBIDDEN', 'Questo profilo non può cambiare utente');
      }

      // Sessione breve senza refresh: alla scadenza il refresh della famiglia
      // originale riporta il dispositivo al profilo di partenza.
      const accessToken = signAccessToken(
        {
          userId: target.id,
          role: target.role,
          sessionId: auth.claims.sid,
          type: 'switch',
          actorId: auth.user.id,
          ttlSec: config.switchTtlSec,
        },
        config.jwtSecret,
      );
      setAccessCookie(reply, accessToken, config.switchTtlSec, config.cookieSecure);
      clearElevationCookie(reply);

      return reply.send(
        sessionResponse(target, config, { temporary: true }),
      );
    },
  );

  app.get(
    '/api/auth/users',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');
      // I guest non vedono l'elenco profili (la UI li blocca già, la API deve
      // applicare lo stesso divieto); il kiosk lo vede solo se elevato.
      if (auth.user.role === 'guest' || (auth.user.role === 'kiosk' && !auth.elevated)) {
        throw new HttpError(403, 'FORBIDDEN', 'Permessi insufficienti per l’elenco profili');
      }
      const users: PublicUser[] = (await db.listUsers()).map((user) => toPublicUser(user));
      return reply.send({ users });
    },
  );

  app.patch(
    '/api/auth/users/:id',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');
      if (auth.user.role !== 'admin') {
        throw new HttpError(403, 'FORBIDDEN', 'Solo un amministratore può modificare i profili');
      }

      const params = asRecord(request.params);
      const userId = typeof params.id === 'string' ? params.id : null;
      if (!userId) throw new HttpError(400, 'INVALID_BODY', 'Profilo non valido');

      const body = asRecord(request.body);
      if (typeof body.active !== 'boolean') {
        throw new HttpError(400, 'INVALID_BODY', 'Il campo active è obbligatorio');
      }
      if (userId === auth.user.id && body.active === false) {
        throw new HttpError(400, 'SELF_DISABLE', 'Non puoi disattivare il tuo profilo');
      }

      const target = await db.findUserById(userId);
      if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'Profilo non trovato');

      await db.setUserActive(userId, body.active);
      if (!body.active) await db.revokeUserRefreshTokens(userId);

      return reply.send({
        user: toPublicUser((await db.findUserById(userId)) ?? target),
      });
    },
  );
}
