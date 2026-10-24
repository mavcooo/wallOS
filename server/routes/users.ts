import type { FastifyInstance } from 'fastify';

import type { Database, UserFields } from '../db.js';
import { HttpError, asRecord, readBoolean, readDigits, readSecret, readString } from '../http.js';
import { hashSecret, pinLengthOf, randomId, toPublicUser } from '../security.js';
import { requireAuth, requireRole } from '../session.js';
import type { AuthConfig, PublicUser, UserRole, UserRow } from '../types.js';

export interface UsersDeps {
  db: Database;
  config: AuthConfig;
}

const ROLES: readonly UserRole[] = ['admin', 'family', 'guest', 'kiosk'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const KIOSK_DEVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD_MIN = 8;

function invalid(message: string, field?: string): HttpError {
  return new HttpError(400, 'INVALID_BODY', message, field ? { field } : undefined);
}

function usernameField(body: Record<string, unknown>, required: boolean): string | undefined {
  const raw = readString(body, 'username', 32);
  if (!raw) {
    if (required) throw invalid('L’username è obbligatorio', 'username');
    return undefined;
  }
  const username = raw.toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw invalid(
      'L’username deve avere 3-32 caratteri: minuscole, cifre, punto, trattino o underscore',
      'username',
    );
  }
  return username;
}

function displayNameField(body: Record<string, unknown>): string | undefined {
  const raw = readString(body, 'displayName', 80) ?? readString(body, 'name', 80);
  return raw ?? undefined;
}

function roleField(body: Record<string, unknown>, required: boolean): UserRole | undefined {
  const value = body.role;
  if (value === undefined) {
    if (required) throw invalid('Il ruolo è obbligatorio', 'role');
    return undefined;
  }
  if (typeof value !== 'string' || !ROLES.includes(value as UserRole)) {
    throw invalid(`Il ruolo deve essere uno di: ${ROLES.join(', ')}`, 'role');
  }
  return value as UserRole;
}

function pinField(body: Record<string, unknown>, config: AuthConfig): string | undefined {
  const pin = readDigits(body, 'pin');
  if (!pin) {
    if (body.pin === undefined) return undefined;
    throw invalid('Il PIN deve contenere solo cifre', 'pin');
  }
  if (pin.length < config.pinPolicy.minLength || pin.length > config.pinPolicy.maxLength) {
    throw invalid(
      `Il PIN deve avere tra ${config.pinPolicy.minLength} e ${config.pinPolicy.maxLength} cifre`,
      'pin',
    );
  }
  return pin;
}

function passwordField(body: Record<string, unknown>): string | undefined {
  if (body.password === undefined) return undefined;
  const password = readSecret(body, 'password', 128);
  if (!password || password.length < PASSWORD_MIN) {
    throw invalid(`La password deve avere almeno ${PASSWORD_MIN} caratteri`, 'password');
  }
  return password;
}

function kioskDeviceField(body: Record<string, unknown>): string | null | undefined {
  if (body.kioskDeviceId === undefined) return undefined;
  if (body.kioskDeviceId === null || body.kioskDeviceId === '') return null;
  const value = readString(body, 'kioskDeviceId', 64);
  if (!value || !KIOSK_DEVICE_RE.test(value)) {
    throw invalid(
      'Il device id deve avere 2-64 caratteri: lettere, cifre, punto, trattino, underscore o due punti',
      'kioskDeviceId',
    );
  }
  return value;
}

async function ensureUsernameFree(
  db: Database,
  username: string,
  exceptId?: string,
): Promise<void> {
  const existing = await db.findUserByUsername(username);
  if (existing && existing.id !== exceptId) {
    throw new HttpError(409, 'USERNAME_TAKEN', 'Questo username è già in uso', {
      field: 'username',
    });
  }
}

async function ensureKioskDeviceFree(
  db: Database,
  deviceId: string,
  exceptId?: string,
): Promise<void> {
  const existing = await db.findKioskByDeviceId(deviceId);
  if (existing && existing.id !== exceptId) {
    throw new HttpError(409, 'KIOSK_DEVICE_TAKEN', 'Questo device id è già associato a un profilo', {
      field: 'kioskDeviceId',
    });
  }
}

function uniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '23505';
}

function userIdParam(params: Record<string, unknown>): string {
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) throw invalid('Profilo non valido', 'id');
  return id;
}

async function userOr404(db: Database, id: string): Promise<UserRow> {
  const user = await db.findUserById(id);
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'Profilo non trovato');
  return user;
}

export function registerUserRoutes(app: FastifyInstance, deps: UsersDeps): void {
  const authenticated = requireAuth(deps);
  const adminOnly = requireRole(deps, ['admin']);

  app.get('/api/users', { preHandler: authenticated }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');
    // Stessa policy della lista profili: i guest non vedono gli account, il
    // kiosk solo dopo la verifica PIN.
    if (auth.user.role === 'guest' || (auth.user.role === 'kiosk' && !auth.elevated)) {
      throw new HttpError(403, 'FORBIDDEN', 'Permessi insufficienti per l’elenco profili');
    }
    const users: PublicUser[] = (await deps.db.listUsers()).map((user) => toPublicUser(user));
    return reply.send({ users });
  });

  app.post('/api/users', { preHandler: adminOnly }, async (request, reply) => {
    const body = asRecord(request.body);
    const username = usernameField(body, true);
    if (!username) throw invalid('L’username è obbligatorio', 'username');

    const role = roleField(body, true) ?? 'family';
    const requestedKiosk = readBoolean(body, 'isKioskDevice');
    const isKiosk = role === 'kiosk' ? true : requestedKiosk ?? false;
    if (isKiosk && role !== 'kiosk') {
      throw invalid('Il flag kiosk richiede il ruolo kiosk', 'role');
    }

    const pin = pinField(body, deps.config);
    if (!pin) throw invalid('Il PIN iniziale è obbligatorio', 'pin');

    const password = passwordField(body);
    if (!isKiosk && !password) {
      throw invalid('La password iniziale è obbligatoria per un account non kiosk', 'password');
    }

    const displayName = displayNameField(body) ?? username;
    const kioskDeviceId = isKiosk
      ? (kioskDeviceField(body) ?? username)
      : null;

    await ensureUsernameFree(deps.db, username);
    if (kioskDeviceId) await ensureKioskDeviceFree(deps.db, kioskDeviceId);

    const [passwordHash, pinHash] = await Promise.all([
      password ? hashSecret(password, deps.config.bcryptRounds) : Promise.resolve(null),
      hashSecret(pin, deps.config.bcryptRounds),
    ]);
    const id = randomId();

    try {
      await deps.db.insertUser({
        id,
        username,
        displayName,
        passwordHash,
        role,
        pinHash,
        pinLength: pinLengthOf(pin),
        isKioskDevice: isKiosk,
        kioskDeviceId,
        allowedRooms: null,
      });
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new HttpError(409, 'USER_EXISTS', 'Username o device id già in uso');
      }
      throw error;
    }

    return reply.code(201).send({ user: toPublicUser(await userOr404(deps.db, id)) });
  });

  app.patch('/api/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');

    const id = userIdParam(asRecord(request.params));
    const target = await userOr404(deps.db, id);
    const body = asRecord(request.body);
    const fields: UserFields = {};
    let revokeSessions = false;

    const username = usernameField(body, false);
    if (username !== undefined) {
      await ensureUsernameFree(deps.db, username, id);
      fields.username = username;
    }

    const displayName = displayNameField(body);
    if (displayName !== undefined) fields.displayName = displayName;

    const role = roleField(body, false);
    const isKiosk = readBoolean(body, 'isKioskDevice');
    const effectiveRole = role ?? target.role;
    // Un ruolo kiosk implica il flag; un cambio ruolo esplicito verso un ruolo
    // normale spegne il flag anche se il client non lo rimanda.
    const effectiveKiosk =
      role !== undefined && role !== 'kiosk'
        ? isKiosk ?? false
        : isKiosk ?? (effectiveRole === 'kiosk' || Boolean(target.is_kiosk_device));

    if (effectiveKiosk && effectiveRole !== 'kiosk') {
      throw invalid('Il flag kiosk richiede il ruolo kiosk', 'role');
    }
    if (role !== undefined && role !== target.role) {
      if (id === auth.user.id) {
        throw new HttpError(400, 'SELF_ROLE', 'Non puoi cambiare il ruolo del tuo profilo');
      }
      fields.role = role;
      revokeSessions = true;
    }
    if (effectiveKiosk !== Boolean(target.is_kiosk_device)) {
      fields.isKioskDevice = effectiveKiosk;
    }

    if (effectiveKiosk) {
      const requested = kioskDeviceField(body);
      const kioskDeviceId =
        requested === undefined
          ? target.kiosk_device_id ?? username ?? target.username
          : requested;
      if (!kioskDeviceId) {
        throw invalid('Il device id è obbligatorio per un profilo kiosk', 'kioskDeviceId');
      }
      await ensureKioskDeviceFree(deps.db, kioskDeviceId, id);
      if (kioskDeviceId !== target.kiosk_device_id) fields.kioskDeviceId = kioskDeviceId;
    } else if (target.kiosk_device_id !== null) {
      fields.kioskDeviceId = null;
      fields.isKioskDevice = false;
    }

    const pin = pinField(body, deps.config);
    if (pin) {
      fields.pinHash = await hashSecret(pin, deps.config.bcryptRounds);
      fields.pinLength = pinLengthOf(pin);
    }

    const password = passwordField(body);
    if (password) {
      fields.passwordHash = await hashSecret(password, deps.config.bcryptRounds);
      revokeSessions = true;
    }
    // Un account non-kiosk senza password non potrebbe accedere: copre anche
    // la conversione kiosk → family fatta senza impostare una password.
    if (!effectiveKiosk && !target.password_hash && !password) {
      throw invalid('Serve una password per un account non kiosk', 'password');
    }

    const active = readBoolean(body, 'active');
    if (active !== null) {
      if (id === auth.user.id && !active) {
        throw new HttpError(400, 'SELF_DISABLE', 'Non puoi disattivare il tuo profilo');
      }
      if (active !== Boolean(target.active)) {
        fields.active = active;
        if (!active) revokeSessions = true;
      }
    }

    const removesAdmin =
      target.role === 'admin' &&
      Boolean(target.active) &&
      ((fields.role !== undefined && fields.role !== 'admin') || fields.active === false);
    if (removesAdmin && (await deps.db.countActiveAdmins(id)) === 0) {
      throw new HttpError(409, 'LAST_ADMIN', 'Deve restare almeno un amministratore attivo');
    }

    if (Object.keys(fields).length === 0) {
      throw invalid('Nessun campo da aggiornare');
    }

    try {
      await deps.db.updateUser(id, fields);
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new HttpError(409, 'USER_EXISTS', 'Username o device id già in uso');
      }
      throw error;
    }
    if (revokeSessions) await deps.db.revokeUserRefreshTokens(id);

    return reply.send({ user: toPublicUser(await userOr404(deps.db, id)) });
  });

  app.delete('/api/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');

    const id = userIdParam(asRecord(request.params));
    if (id === auth.user.id) {
      throw new HttpError(400, 'SELF_DELETE', 'Non puoi eliminare il tuo profilo');
    }

    const target = await userOr404(deps.db, id);
    if (target.role === 'admin' && target.active) {
      if ((await deps.db.countActiveAdmins(id)) === 0) {
        throw new HttpError(409, 'LAST_ADMIN', 'Deve restare almeno un amministratore attivo');
      }
    }

    await deps.db.deleteUser(id);
    return reply.code(204).send();
  });
}
