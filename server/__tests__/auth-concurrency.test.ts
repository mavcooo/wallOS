import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { Database } from '../db.js';
import { hashToken } from '../security.js';
import type { AuthConfig } from '../types.js';

/**
 * Concorrenza reale sulla rotazione del refresh token.
 *
 * PGlite ha una sola connessione: `Database.withTransaction` serializza le
 * transazioni in quel caso, mentre con `pg.Pool` ogni richiesta possiede un
 * client dedicato e il `SELECT ... FOR UPDATE` fa il lavoro. In entrambi i casi
 * il contratto è lo stesso: un solo successore attivo, gli altri 401.
 */

const PASSWORD = 'admin-password-123';
const ADMIN_PIN = '2468';
const KIOSK_PIN = '1234';

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

function cookiesOf(response: LightMyRequestResponse): Record<string, string> {
  const raw = response.headers['set-cookie'];
  const headers = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  const cookies: Record<string, string> = {};
  for (const header of headers) {
    const pair = header.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return cookies;
}

async function setup(): Promise<{ app: FastifyInstance; db: Database }> {
  const config: AuthConfig = loadConfig({
    NODE_ENV: 'test',
    AUTO_SEED: 'true',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN,
    KIOSK_PIN,
    KIOSK_DEVICE_ID: 'wall-panel-1',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    COOKIE_SECURE: 'false',
  });
  const db = await createTestDb();
  const { app } = await buildApp({ config, db });
  openApps.push(app);
  return { app, db };
}

async function login(app: FastifyInstance): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return cookiesOf(response);
}

interface TokenRow {
  id: string;
  family_id: string;
  token_hash: string;
  revoked_at: string | Date | null;
  replaced_by: string | null;
}

async function familyTokens(
  db: Database,
  familyId: string,
): Promise<TokenRow[]> {
  const { rows } = await db.client.query<TokenRow>(
    `SELECT id, family_id, token_hash, revoked_at, replaced_by
     FROM refresh_tokens
     WHERE family_id = $1::uuid
     ORDER BY created_at, id`,
    [familyId],
  );
  return rows;
}

async function familyOf(db: Database, tokenHash: string): Promise<string> {
  const { rows } = await db.client.query<{ family_id: string }>(
    'SELECT family_id FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  const familyId = rows[0]?.family_id;
  if (!familyId) throw new Error('famiglia di refresh token non trovata');
  return familyId;
}

describe('refresh token · concorrenza', () => {
  it('cinque refresh simultanei producono un solo 200 e un solo successore attivo', async () => {
    const { app, db } = await setup();
    const cookies = await login(app);
    const oldToken = cookies.domus_refresh ?? '';
    expect(oldToken.length).toBeGreaterThan(0);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'POST', url: '/api/auth/refresh', cookies }),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    const rejected = responses.filter((response) => response.statusCode === 401);
    expect(rejected).toHaveLength(4);
    for (const response of rejected) {
      expect(response.json()).toMatchObject({ error: 'REFRESH_REUSED' });
    }

    const winner = responses.find((response) => response.statusCode === 200);
    const nextToken = cookiesOf(winner as LightMyRequestResponse).domus_refresh ?? '';
    expect(nextToken).not.toBe('');
    expect(nextToken).not.toBe(oldToken);

    const familyId = await familyOf(db, hashToken(oldToken));
    const rows = await familyTokens(db, familyId);

    // Vecchio token revocato + un solo successore, ancora attivo.
    expect(rows).toHaveLength(2);
    const active = rows.filter((row) => row.revoked_at === null);
    expect(active).toHaveLength(1);
    expect(active[0]?.token_hash).toBe(hashToken(nextToken));

    const consumed = rows.find((row) => row.token_hash === hashToken(oldToken));
    expect(consumed?.revoked_at).not.toBeNull();
    expect(consumed?.replaced_by).toBe(active[0]?.id);
  });

  it('un replay oltre la finestra di grazia revoca tutta la famiglia', async () => {
    const { app, db } = await setup();
    const cookies = await login(app);
    const oldHash = hashToken(cookies.domus_refresh ?? '');

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies,
    });
    expect(first.statusCode).toBe(200);
    const rotatedToken = cookiesOf(first).domus_refresh ?? '';
    expect(rotatedToken).not.toBe('');

    // Sposta indietro nel tempo la revoca del vecchio token: non è più una
    // collisione concorrente ma un riuso successivo.
    await db.client.query(
      `UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute'
       WHERE token_hash = $1`,
      [oldHash],
    );

    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { domus_refresh: cookies.domus_refresh ?? '' },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: 'REFRESH_REUSED' });

    const familyId = await familyOf(db, oldHash);
    const rows = await familyTokens(db, familyId);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);

    // Anche il successore appena emesso è decaduto con la famiglia.
    const afterRevoke = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { domus_refresh: rotatedToken },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('un token scaduto non viene consumato e non genera un successore', async () => {
    const { app, db } = await setup();
    const cookies = await login(app);
    const oldHash = hashToken(cookies.domus_refresh ?? '');

    await db.client.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 second'
       WHERE token_hash = $1`,
      [oldHash],
    );

    const expired = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies,
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: 'EXPIRED_REFRESH' });

    const familyId = await familyOf(db, oldHash);
    const rows = await familyTokens(db, familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });
});
