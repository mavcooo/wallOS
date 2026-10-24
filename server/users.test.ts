import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import type { AuthConfig, SessionResponse } from './types.js';

const ADMIN_PASSWORD = 'admin-password-123';
const ADMIN_PIN = '2468';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

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
  return typeof raw === 'string' ? [raw] : [];
}

function cookiesOf(response: LightMyRequestResponse): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of setCookieHeaders(response)) {
    const pair = header.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return cookies;
}

async function setup(): Promise<{ app: FastifyInstance; config: AuthConfig }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD,
    ADMIN_PIN,
    KIOSK_PIN: '1234',
    KIOSK_DEVICE_ID: 'wall-panel-1',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    COOKIE_SECURE: 'false',
    PIN_MAX_ATTEMPTS: '3',
    PIN_LOCKOUT_MS: '80',
    LOGIN_MAX_ATTEMPTS: '5',
    LOGIN_LOCKOUT_MS: '80',
  });
  const db = await createTestDb();
  const { app } = await buildApp({ config, db });
  openApps.push(app);
  return { app, config };
}

async function login(
  app: FastifyInstance,
  username = 'admin',
  password = ADMIN_PASSWORD,
): Promise<{ response: LightMyRequestResponse; cookies: Record<string, string>; body: SessionResponse }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return { response, cookies: cookiesOf(response), body: response.json<SessionResponse>() };
}

async function adminCookies(app: FastifyInstance): Promise<Record<string, string>> {
  return (await login(app)).cookies;
}

async function createUser(
  app: FastifyInstance,
  cookies: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/users',
    cookies,
    payload: {
      username: 'giulia',
      displayName: 'Giulia Conti',
      role: 'family',
      isKioskDevice: false,
      pin: '1357',
      password: 'family-pass-123',
      ...payload,
    },
  });
}

describe('CRUD profili · /api/users', () => {
  it('crea un profilo, non espone hash e consente il login con la password iniziale', async () => {
    const { app } = await setup();
    const cookies = await adminCookies(app);

    const created = await createUser(app, cookies, {});
    expect(created.statusCode).toBe(201);
    const body = created.json<{ user: { id: string; username: string; role: string; kioskDeviceId: string | null } }>();
    expect(body.user).toMatchObject({
      username: 'giulia',
      role: 'family',
      kioskDeviceId: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/password|pin_hash|pinHash/i);

    const loginAsFamily = await login(app, 'giulia', 'family-pass-123');
    expect(loginAsFamily.response.statusCode).toBe(200);
    expect(loginAsFamily.body.user.role).toBe('family');

    const list = await app.inject({ method: 'GET', url: '/api/users', cookies });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toMatch(/password|pin_hash|pinHash/i);

    const denied = await createUser(app, loginAsFamily.cookies, {
      username: 'altro',
      password: 'another-pass-123',
    });
    expect(denied.statusCode).toBe(403);
  });

  it('aggiorna username, password, PIN e stato attivo', async () => {
    const { app } = await setup();
    const cookies = await adminCookies(app);
    const created = await createUser(app, cookies, {});
    const id = created.json<{ user: { id: string } }>().user.id;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/users/${id}`,
      cookies,
      payload: {
        username: 'giulia-rossi',
        displayName: 'Giulia Rossi',
        password: 'nuova-pass-123',
        pin: '246810',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      user: { username: 'giulia-rossi', name: 'Giulia Rossi', pinLength: 6 },
    });

    expect((await login(app, 'giulia-rossi', 'nuova-pass-123')).response.statusCode).toBe(200);
    expect((await login(app, 'giulia', 'family-pass-123')).response.statusCode).toBe(401);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/users/${id}`,
      cookies,
      payload: { active: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ user: { active: false } });

    const blocked = await login(app, 'giulia-rossi', 'nuova-pass-123');
    expect(blocked.response.statusCode).toBe(403);
    expect(blocked.response.json()).toMatchObject({ error: 'ACCOUNT_DISABLED' });

    const enabled = await app.inject({
      method: 'PATCH',
      url: `/api/users/${id}`,
      cookies,
      payload: { active: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect((await login(app, 'giulia-rossi', 'nuova-pass-123')).response.statusCode).toBe(200);
  });

  it('crea un kiosk con device id e PIN, senza password, e ne aggiorna l’identità', async () => {
    const { app } = await setup();
    const cookies = await adminCookies(app);

    const created = await createUser(app, cookies, {
      username: 'panel-cucina',
      displayName: 'Pannello cucina',
      role: 'kiosk',
      isKioskDevice: true,
      kioskDeviceId: 'panel-cucina-1',
      pin: '4321',
      password: undefined,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      user: { role: 'kiosk', isKioskDevice: true, kioskDeviceId: 'panel-cucina-1' },
    });

    const kiosk = await app.inject({
      method: 'POST',
      url: '/api/auth/kiosk-session',
      payload: { deviceId: 'panel-cucina-1', pin: '4321' },
    });
    expect(kiosk.statusCode).toBe(200);

    const id = created.json<{ user: { id: string } }>().user.id;
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/users/${id}`,
      cookies,
      payload: { kioskDeviceId: 'panel-cucina-2', pin: '9876' },
    });
    expect(updated.statusCode).toBe(200);

    const oldDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/kiosk-session',
      payload: { deviceId: 'panel-cucina-1', pin: '4321' },
    });
    expect(oldDevice.statusCode).toBe(401);

    const newDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/kiosk-session',
      payload: { deviceId: 'panel-cucina-2', pin: '9876' },
    });
    expect(newDevice.statusCode).toBe(200);
  });

  it('protegge l’auto-eliminazione e rimuove profilo e sessioni', async () => {
    const { app } = await setup();
    const cookies = await adminCookies(app);
    const created = await createUser(app, cookies, {});
    const id = created.json<{ user: { id: string } }>().user.id;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    const adminId = me.json<SessionResponse>().user.id;

    const selfDelete = await app.inject({
      method: 'DELETE',
      url: `/api/users/${adminId}`,
      cookies,
    });
    expect(selfDelete.statusCode).toBe(400);
    expect(selfDelete.json()).toMatchObject({ error: 'SELF_DELETE' });

    const selfDemote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      cookies,
      payload: { role: 'family' },
    });
    expect(selfDemote.statusCode).toBe(400);
    expect(selfDemote.json()).toMatchObject({ error: 'SELF_ROLE' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/users/${id}`,
      cookies,
    });
    expect(deleted.statusCode).toBe(204);

    expect((await login(app, 'giulia', 'family-pass-123')).response.statusCode).toBe(401);
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/users/${id}`,
      cookies,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rifiuta username duplicati e corpi non validi', async () => {
    const { app } = await setup();
    const cookies = await adminCookies(app);

    expect((await createUser(app, cookies, {})).statusCode).toBe(201);
    const duplicate = await createUser(app, cookies, {});
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'USERNAME_TAKEN' });

    const weakPin = await createUser(app, cookies, {
      username: 'pin-corto',
      pin: '12',
    });
    expect(weakPin.statusCode).toBe(400);

    const kioskMismatch = await createUser(app, cookies, {
      username: 'flag-sbagliato',
      role: 'family',
      isKioskDevice: true,
    });
    expect(kioskMismatch.statusCode).toBe(400);
  });
});
