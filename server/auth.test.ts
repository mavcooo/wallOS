import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database, type AuthDb } from './db.js';
import { hashSecret } from './security.js';
import type { AuthConfig, SessionResponse } from './types.js';

const PASSWORD = 'admin-password-123';
const ADMIN_PIN = '2468';
const KIOSK_PIN = '1234';
const FAMILY_PASSWORD = 'family-password-123';
const FAMILY_PIN = '1357';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

/**
 * PostgreSQL vero (WASM) senza un'istanza locale: lo schema, le FK e il JSONB
 * dei test sono esattamente quelli di produzione.
 */
async function createTestDb(): Promise<Database> {
  const engine = new PGlite();
  openEngines.push(engine);
  return new Database({
    connectionString: 'postgres://test:test@localhost:5432/test',
    client: {
      async query<T>(sql: string, params?: readonly unknown[]) {
        const result = await engine.query<T>(sql, params ? [...params] : undefined);
        return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
      },
      async exec(sql: string) {
        await engine.exec(sql);
      },
    },
  });
}

function setCookieHeaders(response: LightMyRequestResponse): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return [raw];
  return [];
}

function cookiesOf(response: LightMyRequestResponse): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of setCookieHeaders(response)) {
    const pair = header.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) {
      cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return cookies;
}

function cookieHeader(response: LightMyRequestResponse, name: string): string {
  return setCookieHeaders(response).find((header) => header.startsWith(`${name}=`)) ?? '';
}

async function setup(): Promise<{ app: FastifyInstance; db: AuthDb; config: AuthConfig }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN,
    KIOSK_PIN,
    KIOSK_DEVICE_ID: 'wall-panel-1',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    COOKIE_SECURE: 'false',
    PIN_MAX_ATTEMPTS: '3',
    PIN_LOCKOUT_MS: '80',
    LOGIN_MAX_ATTEMPTS: '3',
    LOGIN_LOCKOUT_MS: '80',
  });
  const db = await createTestDb();
  const { app } = await buildApp({ config, db });
  openApps.push(app);
  return { app, db, config };
}

async function addFamily(db: AuthDb): Promise<string> {
  const familyId = randomUUID();
  await db.insertUser({
    id: familyId,
    username: 'family',
    displayName: 'Giulia Conti',
    passwordHash: await hashSecret(FAMILY_PASSWORD, 4),
    role: 'family',
    pinHash: await hashSecret(FAMILY_PIN, 4),
    pinLength: 4,
    isKioskDevice: false,
    kioskDeviceId: null,
    allowedRooms: ['living', 'kitchen'],
  });
  await db.insertUser({
    id: randomUUID(),
    username: 'guest',
    displayName: 'Ospite',
    passwordHash: await hashSecret('guest-password-123', 4),
    role: 'guest',
    pinHash: await hashSecret('9753', 4),
    pinLength: 4,
    isKioskDevice: false,
    kioskDeviceId: null,
    allowedRooms: ['living'],
  });
  return familyId;
}

async function login(
  app: FastifyInstance,
  username = 'admin',
  password = PASSWORD,
): Promise<{ response: LightMyRequestResponse; cookies: Record<string, string>; body: SessionResponse }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return { response, cookies: cookiesOf(response), body: response.json<SessionResponse>() };
}

async function kioskLogin(
  app: FastifyInstance,
  pin = KIOSK_PIN,
): Promise<{ response: LightMyRequestResponse; cookies: Record<string, string> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/kiosk-session',
    payload: { deviceId: 'wall-panel-1', pin },
  });
  return { response, cookies: cookiesOf(response) };
}

describe('login e cookie di sessione', () => {
  it('emette access/refresh HttpOnly, SameSite=Strict e profilo sanitizzato', async () => {
    const { app } = await setup();
    const { response, body } = await login(app);

    expect(response.statusCode).toBe(200);
    expect(body.user).toMatchObject({
      username: 'admin',
      role: 'admin',
      name: 'Amministratore',
      pinLength: 4,
    });
    expect(body.pinPolicy).toMatchObject({ maxAttempts: 3, lockoutMs: 80 });
    expect(JSON.stringify(body)).not.toMatch(/password|pin_hash|pinHash/i);

    const access = cookieHeader(response, 'domus_access');
    expect(access).toContain('HttpOnly');
    expect(access).toContain('SameSite=Strict');
    expect(access).toContain('Path=/');

    const refresh = cookieHeader(response, 'domus_refresh');
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('Path=/api/auth');
    expect(refresh).toContain('Max-Age=');
  });

  it('non rivela se un username esiste e blocca dopo troppi tentativi', async () => {
    const { app } = await setup();

    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost', password: 'whatever-123' },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: 'INVALID_CREDENTIALS' });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong-password' },
      });
      expect(wrong.statusCode).toBe(401);
    }

    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-password' },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: 'LOGIN_LOCKED' });
    expect(locked.headers['retry-after']).toBeDefined();

    // Nemmeno la password corretta passa durante il lockout.
    const correctDuringLock = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    });
    expect(correctDuringLock.statusCode).toBe(429);
  });
});

describe('sessione corrente', () => {
  it('GET /api/auth/me richiede il cookie e restituisce solo dati pubblici', async () => {
    const { app } = await setup();

    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);

    const { cookies } = await login(app);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json<SessionResponse>()).toMatchObject({
      user: { username: 'admin', role: 'admin' },
      elevated: false,
      temporary: false,
    });
    expect(JSON.stringify(me.json())).not.toMatch(/password|pin_hash/i);
  });
});

describe('verifica PIN lato server', () => {
  it('blocca dopo 3 errori e riapre dopo il lockout', async () => {
    const { app } = await setup();
    const { cookies } = await login(app);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-pin',
        cookies,
        payload: { pin: '0000' },
      });
      expect(wrong.statusCode).toBe(200);
      expect(wrong.json()).toMatchObject({ ok: false, locked: false });
    }

    const third = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-pin',
      cookies,
      payload: { pin: '0000' },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json()).toMatchObject({ ok: false, locked: true, remainingAttempts: 0 });
    expect(third.json<{ retryAfterMs: number }>().retryAfterMs).toBeGreaterThan(0);

    const duringLock = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-pin',
      cookies,
      payload: { pin: ADMIN_PIN },
    });
    expect(duringLock.json()).toMatchObject({ ok: false, locked: true });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const correct = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-pin',
      cookies,
      payload: { pin: ADMIN_PIN },
    });
    expect(correct.statusCode).toBe(200);
    expect(correct.json()).toMatchObject({ ok: true, locked: false, elevatedUntil: expect.any(Number) });

    const elevationCookie = cookieHeader(correct, 'domus_elevation');
    expect(elevationCookie).toContain('HttpOnly');
    expect(elevationCookie).toContain('SameSite=Strict');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { ...cookies, ...cookiesOf(correct) },
    });
    expect(me.json()).toMatchObject({ elevated: true });
  });
});

describe('sessione kiosk', () => {
  it('accetta solo device+PIN e mantiene una sessione rinnovabile', async () => {
    const { app } = await setup();

    const wrong = await kioskLogin(app, '9999');
    expect(wrong.response.statusCode).toBe(401);
    expect(wrong.response.json()).toMatchObject({ error: 'INVALID_KIOSK_PIN' });

    const { response, cookies } = await kioskLogin(app);
    expect(response.statusCode).toBe(200);
    expect(response.json<SessionResponse>().user).toMatchObject({
      role: 'kiosk',
      isKioskDevice: true,
    });

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    expect(me.statusCode).toBe(200);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json<SessionResponse>().user.role).toBe('kiosk');

    // Il device kiosk non ha password: il login account non è una via d'accesso.
    const accountLogin = await login(app, 'kiosk', 'admin1234');
    expect(accountLogin.response.statusCode).toBe(401);
  });
});

describe('rotazione refresh token', () => {
  it('ruota il token e revoca l’intera famiglia al riuso', async () => {
    const { app } = await setup();
    const { cookies } = await login(app);

    const firstRefresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies,
    });
    expect(firstRefresh.statusCode).toBe(200);
    const rotated = { ...cookies, ...cookiesOf(firstRefresh) };
    expect(rotated.domus_refresh).not.toBe(cookies.domus_refresh);

    // Riuso del vecchio refresh: furto rilevato.
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { domus_refresh: cookies.domus_refresh ?? '' },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ error: 'REFRESH_REUSED' });

    // Anche il token ruotato appena emesso è stato revocato con la famiglia.
    const afterFamilyRevoke = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { domus_refresh: rotated.domus_refresh ?? '' },
    });
    expect(afterFamilyRevoke.statusCode).toBe(401);
  });

  it('logout revoca la sessione e cancella i cookie', async () => {
    const { app } = await setup();
    const { cookies } = await login(app);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies,
    });
    expect(logout.statusCode).toBe(204);
    expect(setCookieHeaders(logout).join(';')).toContain('domus_access=;');

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies,
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe('RBAC e profili', () => {
  it('solo admin modifica i profili; la lista non espone hash', async () => {
    const { app, db } = await setup();
    const familyId = await addFamily(db);

    const admin = await login(app);
    const list = await app.inject({
      method: 'GET',
      url: '/api/auth/users',
      cookies: admin.cookies,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      users: expect.arrayContaining([
        expect.objectContaining({ id: familyId, username: 'family', role: 'family' }),
        expect.objectContaining({ username: 'kiosk', role: 'kiosk' }),
      ]),
    });
    expect(JSON.stringify(list.json())).not.toMatch(/password|pin_hash|pinHash/i);

    const guest = await login(app, 'guest', 'guest-password-123');
    const guestList = await app.inject({
      method: 'GET',
      url: '/api/auth/users',
      cookies: guest.cookies,
    });
    expect(guestList.statusCode).toBe(403);

    const family = await login(app, 'family', FAMILY_PASSWORD);
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/auth/users/${familyId}`,
      cookies: family.cookies,
      payload: { active: false },
    });
    expect(denied.statusCode).toBe(403);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/auth/users/${familyId}`,
      cookies: admin.cookies,
      payload: { active: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ user: { active: false } });

    const disabledLogin = await login(app, 'family', FAMILY_PASSWORD);
    expect(disabledLogin.response.statusCode).toBe(403);
    expect(disabledLogin.response.json()).toMatchObject({ error: 'ACCOUNT_DISABLED' });
  });

  it('admin non può disattivare se stesso', async () => {
    const { app } = await setup();
    const admin = await login(app);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: admin.cookies,
    });
    const id = me.json<SessionResponse>().user.id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/auth/users/${id}`,
      cookies: admin.cookies,
      payload: { active: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'SELF_DISABLE' });
  });

  it('il kiosk passa temporaneamente a family e il refresh lo riporta a kiosk', async () => {
    const { app, db } = await setup();
    const familyId = await addFamily(db);
    const kiosk = await kioskLogin(app);

    const switched = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-profile',
      cookies: kiosk.cookies,
      payload: { userId: familyId, pin: KIOSK_PIN },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json<SessionResponse>()).toMatchObject({
      user: { id: familyId, role: 'family' },
      temporary: true,
    });

    const switchedCookies = { ...kiosk.cookies, ...cookiesOf(switched) };
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: switchedCookies,
    });
    expect(me.json()).toMatchObject({ user: { role: 'family' }, temporary: true });

    // Il refresh appartiene ancora alla famiglia kiosk.
    const restored = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: switchedCookies,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<SessionResponse>().user.role).toBe('kiosk');
  });

  it('family non può salire ad admin, il kiosk non può passare ad admin', async () => {
    const { app, db } = await setup();
    await addFamily(db);
    const admin = await login(app);
    const adminId = admin.body.user.id;

    const family = await login(app, 'family', FAMILY_PASSWORD);
    const upward = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-profile',
      cookies: family.cookies,
      payload: { userId: adminId, pin: FAMILY_PIN },
    });
    expect(upward.statusCode).toBe(403);

    const kiosk = await kioskLogin(app);
    const kioskUpward = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-profile',
      cookies: kiosk.cookies,
      payload: { userId: adminId, pin: KIOSK_PIN },
    });
    expect(kioskUpward.statusCode).toBe(403);
  });
});

describe('diagnostica database', () => {
  it('legge versione e identità del server per il log di avvio', async () => {
    const { db } = await setup();

    const info = await db.serverInfo();

    expect(info.version).toMatch(/PostgreSQL/i);
    expect(info.database.length).toBeGreaterThan(0);
    expect(info.user.length).toBeGreaterThan(0);
    // Il log di startup non deve contenere credenziali.
    expect(JSON.stringify(info)).not.toMatch(/password|postgres:\/\//i);
  });
});

describe('health con stato del database', () => {
  it('risponde 200 con versione PostgreSQL e latenza', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      database: {
        status: 'up',
        version: expect.stringMatching(/^PostgreSQL \d+/),
        latencyMs: expect.any(Number),
      },
    });
  });

  it('risponde 503 con il codice di errore quando il database è irraggiungibile', async () => {
    const { app, db } = await setup();
    vi.spyOn(db, 'serverInfo').mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    );

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      database: { status: 'down', error: 'ECONNREFUSED' },
    });
  });
});

describe('protezione delle richieste', () => {
  it('rifiuta un Origin non consentito sulle richieste mutanti', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://evil.example' },
      payload: { username: 'admin', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'ORIGIN_NOT_ALLOWED' });
  });
});
