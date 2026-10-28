import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { kioskConfigTopic } from './services/kioskEvents.js';
import type { AuthConfig, KioskConfigEvent } from './types.js';

const PASSWORD = 'admin-password-123';
const KIOSK_ID = 'kiosk_5f0f2c1e-3c4a-4b6e-9a10-9a3f0f8a1b2c';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

function fakePublisher() {
  const published: KioskConfigEvent[] = [];
  return {
    published,
    publisher: {
      publish(event: KioskConfigEvent) {
        published.push(event);
      },
      close: async () => undefined,
    },
  };
}

async function setup() {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTO_SEED: 'true',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN: '2468',
    KIOSK_PIN: '1234',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    MQTT_BASE_TOPIC: 'casa',
    AUTOMATION_LATITUDE: '41.9028',
    AUTOMATION_LONGITUDE: '12.4964',
  });

  const engine = new PGlite();
  openEngines.push(engine);
  const db = new Database({
    connectionString: config.databaseUrl,
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

  const mqtt = fakePublisher();
  const { app } = await buildApp({ config, db, kioskPublisher: mqtt.publisher });
  openApps.push(app);
  return { app, config: config as AuthConfig, db, mqtt };
}

function cookiesOf(response: { headers: Record<string, unknown> }): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of (response.headers['set-cookie'] as string[] | undefined) ?? []) {
    const pair = String(header).split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return cookies;
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

async function kioskLogin(app: FastifyInstance): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/kiosk-session',
    payload: { deviceId: 'wall-panel-1', pin: '1234' },
  });
  expect(response.statusCode).toBe(200);
  return cookiesOf(response);
}

interface DisplayJson {
  id: string;
  name: string;
  defaultRoomId: string | null;
  dimmerTimeoutSec: number;
  dimmerScreensaverMode: string;
  performanceMode: boolean;
  highContrast: boolean;
  pinRequired: boolean;
  screenOrientation: string;
  isActive: boolean;
  lastSeenAt: number | null;
  online: boolean;
}

describe('display · auto-registrazione', () => {
  it('registra il pannello al primo avvio con i default, senza 404', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/kiosk/${KIOSK_ID}`,
      cookies,
    });

    expect(response.statusCode).toBe(200);
    const display = (response.json() as { display: DisplayJson }).display;
    expect(display.id).toBe(KIOSK_ID);
    expect(display.name).toBe(`Nuovo Display (${KIOSK_ID})`);
    expect(display.dimmerTimeoutSec).toBe(120);
    expect(display.dimmerScreensaverMode).toBe('clock_float');
    expect(display.pinRequired).toBe(true);
    expect(display.screenOrientation).toBe('landscape');
    expect(display.lastSeenAt).not.toBeNull();
    expect(display.online).toBe(true);
  });

  it('non duplica la riga a ogni avvio e compare nell’elenco admin', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    await app.inject({ method: 'GET', url: `/api/kiosk/${KIOSK_ID}`, cookies });
    await app.inject({ method: 'GET', url: `/api/kiosk/${KIOSK_ID}`, cookies });

    const list = await app.inject({ method: 'GET', url: '/api/kiosk', cookies });
    expect(list.statusCode).toBe(200);
    const displays = (list.json() as { displays: DisplayJson[] }).displays;
    expect(displays).toHaveLength(1);
    expect(displays[0]?.id).toBe(KIOSK_ID);
  });

  it('rifiuta un id non valido (slash o spazi)', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    for (const id of ['tablet%2Fingresso', 'tablet%20ingresso']) {
      const response = await app.inject({ method: 'GET', url: `/api/kiosk/${id}`, cookies });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('display · configurazione', () => {
  it('salva i campi e pubblica la notifica MQTT per quel pannello', async () => {
    const { app, mqtt } = await setup();
    const cookies = await login(app);
    await app.inject({ method: 'GET', url: `/api/kiosk/${KIOSK_ID}`, cookies });
    mqtt.published.length = 0;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/kiosk/${KIOSK_ID}`,
      cookies,
      payload: {
        name: 'Pannello Ingresso',
        dimmerTimeoutSec: 300,
        highContrast: true,
        performanceMode: true,
        defaultRoomId: 'living',
        screenOrientation: 'portrait',
      },
    });

    expect(response.statusCode).toBe(200);
    const display = (response.json() as { display: DisplayJson }).display;
    expect(display.name).toBe('Pannello Ingresso');
    expect(display.dimmerTimeoutSec).toBe(300);
    expect(display.highContrast).toBe(true);
    expect(display.defaultRoomId).toBe('living');
    expect(display.screenOrientation).toBe('portrait');

    expect(mqtt.published).toHaveLength(1);
    expect(mqtt.published[0]?.id).toBe(KIOSK_ID);
    expect((mqtt.published[0]?.config as DisplayJson).dimmerTimeoutSec).toBe(300);
  });

  it('accetta solo i campi previsti e i limiti del dimmer', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    await app.inject({ method: 'GET', url: `/api/kiosk/${KIOSK_ID}`, cookies });

    const tooLong = await app.inject({
      method: 'PUT',
      url: `/api/kiosk/${KIOSK_ID}`,
      cookies,
      payload: { dimmerTimeoutSec: 5000 },
    });
    expect(tooLong.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'PUT',
      url: `/api/kiosk/${KIOSK_ID}`,
      cookies,
      payload: { brightness: 80 },
    });
    expect(unknown.statusCode).toBe(400);

    const badRoom = await app.inject({
      method: 'PUT',
      url: `/api/kiosk/${KIOSK_ID}`,
      cookies,
      payload: { defaultRoomId: 'stanza_inesistente' },
    });
    expect(badRoom.statusCode).toBe(400);
    expect((badRoom.json() as { error: string }).error).toBe('ROOM_NOT_FOUND');
  });

  it('la notifica MQTT usa il topic del pannello sotto il base topic', () => {
    expect(kioskConfigTopic('casa', KIOSK_ID)).toBe(
      `casa/wallos/system/kiosk/${KIOSK_ID}/config_updated`,
    );
    expect(kioskConfigTopic('', KIOSK_ID)).toBe(
      `wallos/system/kiosk/${KIOSK_ID}/config_updated`,
    );
  });
});

describe('display · autorizzazione', () => {
  it('senza sessione non si legge né si scrive', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/kiosk' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'PUT', url: `/api/kiosk/${KIOSK_ID}`, payload: {} })).statusCode,
    ).toBe(401);
  });

  it('l’elenco completo è riservato all’amministratore', async () => {
    const { app } = await setup();
    const cookies = await kioskLogin(app);
    expect((await app.inject({ method: 'GET', url: '/api/kiosk', cookies })).statusCode).toBe(403);
  });

  it('il pannello cambia le proprie preferenze ma non nome, stato o altri display', async () => {
    const { app } = await setup();
    const admin = await login(app);
    const kiosk = await kioskLogin(app);

    // Il profilo kiosk è `wall-panel-1` (dal seed).
    await app.inject({ method: 'GET', url: '/api/kiosk/wall-panel-1', cookies: admin });

    const own = await app.inject({
      method: 'GET',
      url: '/api/kiosk/wall-panel-1',
      cookies: kiosk,
    });
    expect(own.statusCode).toBe(200);

    const another = await app.inject({
      method: 'GET',
      url: `/api/kiosk/${KIOSK_ID}`,
      cookies: kiosk,
    });
    expect(another.statusCode).toBe(403);

    const preferences = await app.inject({
      method: 'PUT',
      url: '/api/kiosk/wall-panel-1',
      cookies: kiosk,
      payload: { dimmerTimeoutSec: 60, highContrast: true },
    });
    expect(preferences.statusCode).toBe(200);

    const rename = await app.inject({
      method: 'PUT',
      url: '/api/kiosk/wall-panel-1',
      cookies: kiosk,
      payload: { name: 'Rinominato dal pannello' },
    });
    expect(rename.statusCode).toBe(403);

    const deactivate = await app.inject({
      method: 'PUT',
      url: '/api/kiosk/wall-panel-1',
      cookies: kiosk,
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(403);
  });

  it('un PUT su un display mai registrato risponde 404', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/kiosk/tablet_sconosciuto',
      cookies,
      payload: { dimmerTimeoutSec: 90 },
    });
    expect(response.statusCode).toBe(404);
  });
});
