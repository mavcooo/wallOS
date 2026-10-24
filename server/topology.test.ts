import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { initialDevices } from './seed-data/devices.js';
import { SEED_ROOMS } from './seed-data/rooms.js';
import { SCENARIOS } from './seed-data/scenarios.js';
import type { AuthConfig } from './types.js';

const PASSWORD = 'admin-password-123';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

async function setup(): Promise<{ app: FastifyInstance; config: AuthConfig }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN: '2468',
    KIOSK_PIN: '1234',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
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

  const { app } = await buildApp({ config, db });
  openApps.push(app);
  return { app, config };
}

async function kioskLogin(app: FastifyInstance): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/kiosk-session',
    payload: { deviceId: 'wall-panel-1', pin: '1234' },
  });
  expect(response.statusCode).toBe(200);

  const cookies: Record<string, string> = {};
  for (const header of response.headers['set-cookie'] ?? []) {
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

  const cookies: Record<string, string> = {};
  for (const header of response.headers['set-cookie'] ?? []) {
    const pair = String(header).split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return cookies;
}

describe('topologia dal database', () => {
  it('richiede una sessione: nessun dato di casa in chiaro', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/topology' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'UNAUTHENTICATED' });
  });

  it('restituisce stanze, dispositivi e scenari del seed', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({ method: 'GET', url: '/api/topology', cookies });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      rooms: { id: string; label: string; shortLabel: string }[];
      devices: { id: string; room: string; kind: string; topics: { state: string } }[];
      scenarios: { id: string; steps: unknown[] }[];
    }>();

    expect(body.rooms).toHaveLength(SEED_ROOMS.length);
    expect(body.rooms[0]).toMatchObject({ id: 'living', label: 'Soggiorno' });
    expect(body.devices).toHaveLength(initialDevices.length);
    expect(body.scenarios).toHaveLength(SCENARIOS.length);

    // Il modello arriva ricostruito: room_id → room, metadata → state/topics.
    expect(body.devices.find((device) => device.id === 'light-living-main')).toMatchObject({
      room: 'living',
      kind: 'light',
      topics: { state: 'zigbee2mqtt/living/main' },
    });
    expect(body.scenarios.find((scenario) => scenario.id === 'cinema')?.steps.length).toBeGreaterThan(0);
  });

  it('un admin crea, modifica ed elimina una stanza', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      cookies,
      payload: { name: 'Garage', shortLabel: 'Garage', icon: 'car' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      room: { id: 'garage', label: 'Garage', icon: 'car', displayOrder: 0 },
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/rooms/garage',
      cookies,
      payload: { name: 'Garage grande', shortLabel: 'Garage', displayOrder: 8 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      room: { id: 'garage', label: 'Garage grande', displayOrder: 8 },
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/rooms/garage',
      cookies,
    });
    expect(deleted.statusCode).toBe(204);

    const rooms = await app.inject({ method: 'GET', url: '/api/rooms', cookies });
    expect(rooms.json<{ rooms: { id: string }[] }>().rooms.some((room) => room.id === 'garage')).toBe(
      false,
    );
  });

  it('rifiuta slug non validi, duplicati e stanze ancora popolate', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const invalidId = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      cookies,
      payload: { id: 'Garage Nuovo', name: 'Garage' },
    });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json()).toMatchObject({ error: 'INVALID_BODY', field: 'id' });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      cookies,
      payload: { id: 'living', name: 'Doppione' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'ROOM_EXISTS' });

    const populated = await app.inject({
      method: 'DELETE',
      url: '/api/rooms/living',
      cookies,
    });
    expect(populated.statusCode).toBe(409);
    expect(populated.json()).toMatchObject({ error: 'ROOM_NOT_EMPTY' });

    const kiosk = await kioskLogin(app);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      cookies: kiosk,
      payload: { name: 'Garage' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('valida e salva un dispositivo, preservando lo stato in modifica', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const badType = await app.inject({
      method: 'POST',
      url: '/api/devices',
      cookies,
      payload: {
        id: 'light-garage',
        roomId: 'garage',
        name: 'Luce garage',
        type: 'television',
        stateTopic: 'casa/garage/light',
      },
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json()).toMatchObject({ error: 'INVALID_BODY', field: 'type' });

    const missingRoom = await app.inject({
      method: 'POST',
      url: '/api/devices',
      cookies,
      payload: {
        id: 'light-garage',
        roomId: 'garage',
        name: 'Luce garage',
        type: 'light',
        adapter: 'zigbee2mqtt',
        stateTopic: 'casa/garage/light',
      },
    });
    expect(missingRoom.statusCode).toBe(400);
    expect(missingRoom.json()).toMatchObject({ error: 'ROOM_NOT_FOUND' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/devices',
      cookies,
      payload: {
        id: 'light-garage',
        roomId: 'living',
        name: 'Luce garage',
        type: 'light',
        adapter: 'zigbee2mqtt',
        stateTopic: 'casa/garage/light',
        commandTopic: 'casa/garage/light/set',
        favorite: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      device: {
        id: 'light-garage',
        room: 'living',
        kind: 'light',
        favorite: true,
        topics: { state: 'casa/garage/light', command: 'casa/garage/light/set' },
        state: { on: false, brightness: 0 },
      },
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/devices/light-garage',
      cookies,
      payload: {
        roomId: 'living',
        name: 'Luce garage 2',
        type: 'light',
        adapter: 'zigbee2mqtt',
        stateTopic: 'casa/garage/light',
        protected: true,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      device: { name: 'Luce garage 2', protected: true, favorite: false },
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/devices/light-garage',
      cookies,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('crea una telecamera con endpoint, snapshot e formato, poi li aggiorna', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const missingStream = await app.inject({
      method: 'POST',
      url: '/api/devices',
      cookies,
      payload: {
        id: 'camera-garage',
        roomId: 'living',
        name: 'Telecamera garage',
        type: 'camera',
      },
    });
    expect(missingStream.statusCode).toBe(400);
    expect(missingStream.json()).toMatchObject({ field: 'streamUrl' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/devices',
      cookies,
      payload: {
        id: 'camera-garage',
        roomId: 'living',
        name: 'Telecamera garage',
        type: 'camera',
        adapter: 'custom-json',
        streamUrl: 'http://192.168.0.59:1984/api/webrtc?src=garage',
        snapshotUrl: 'http://192.168.0.59:1984/api/frame.jpeg?src=garage',
        streamProtocol: 'auto',
        aspectRatio: '4:3',
        favorite: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      device: {
        id: 'camera-garage',
        kind: 'camera',
        favorite: true,
        topics: { state: 'camera/camera-garage' },
        state: { live: true },
        stream: {
          url: 'http://192.168.0.59:1984/api/webrtc?src=garage',
          snapshotUrl: 'http://192.168.0.59:1984/api/frame.jpeg?src=garage',
          protocol: 'auto',
          aspectRatio: '4:3',
        },
      },
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/devices/camera-garage',
      cookies,
      payload: {
        roomId: 'living',
        name: 'Telecamera garage',
        type: 'camera',
        adapter: 'custom-json',
        streamUrl: 'http://192.168.0.59:1984/api/stream.m3u8?src=garage',
        streamProtocol: 'hls',
        aspectRatio: '16:9',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      device: {
        stream: {
          url: 'http://192.168.0.59:1984/api/stream.m3u8?src=garage',
          protocol: 'hls',
          aspectRatio: '16:9',
        },
      },
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/devices/camera-garage',
      cookies,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('valida i passi di uno scenario prima di salvarli', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const badAction = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      cookies,
      payload: {
        id: 'garage-off',
        label: 'Garage off',
        actions: [{ deviceId: 'light-living-main', action: { type: 'teleport' } }],
      },
    });
    expect(badAction.statusCode).toBe(400);
    expect(badAction.json()).toMatchObject({ error: 'INVALID_BODY', field: 'actions' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      cookies,
      payload: {
        id: 'garage-off',
        label: 'Garage off',
        description: 'Spegne la luce del garage',
        protected: true,
        actions: [
          { deviceId: 'light-living-main', action: { type: 'power', on: false }, delayMs: 500 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      scenario: {
        id: 'garage-off',
        label: 'Garage off',
        protected: true,
        steps: [{ deviceId: 'light-living-main', delayMs: 500 }],
      },
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/scenarios/garage-off',
      cookies,
      payload: {
        label: 'Garage spento',
        actions: [{ deviceId: 'light-living-main', action: { type: 'brightness', brightness: 20 } }],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      scenario: { label: 'Garage spento', steps: [{ action: { type: 'brightness', brightness: 20 } }] },
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/scenarios/garage-off',
      cookies,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('rifiuta le mutazioni non admin su dispositivi e scenari', async () => {
    const { app } = await setup();
    const kiosk = await kioskLogin(app);

    const requests = [
      {
        method: 'POST' as const,
        url: '/api/devices',
        payload: {
          roomId: 'living',
          name: 'Device kiosk',
          type: 'light',
          stateTopic: 'zz/kiosk/state',
        },
      },
      { method: 'PATCH' as const, url: '/api/devices/light-living-main', payload: {} },
      { method: 'DELETE' as const, url: '/api/devices/light-living-main' },
      {
        method: 'POST' as const,
        url: '/api/scenarios',
        payload: { label: 'Scenario kiosk', actions: [] },
      },
      { method: 'PATCH' as const, url: '/api/scenarios/cinema', payload: {} },
      { method: 'DELETE' as const, url: '/api/scenarios/cinema' },
    ];

    for (const request of requests) {
      const response = await app.inject({ ...request, cookies: kiosk });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: 'FORBIDDEN' });
    }

    // Il kiosk non ha modificato nulla: il device del seed è ancora lì.
    const admin = await login(app);
    const devices = await app.inject({ method: 'GET', url: '/api/devices', cookies: admin });
    expect(
      devices
        .json<{ devices: { id: string }[] }>()
        .devices.some((device) => device.id === 'light-living-main'),
    ).toBe(true);
  });

  it('risponde 404 su PATCH e DELETE di entità inesistenti', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const cases = [
      { method: 'PATCH' as const, url: '/api/rooms/zz-missing', error: 'ROOM_NOT_FOUND' },
      { method: 'DELETE' as const, url: '/api/rooms/zz-missing', error: 'ROOM_NOT_FOUND' },
      { method: 'PATCH' as const, url: '/api/devices/zz-missing', error: 'DEVICE_NOT_FOUND' },
      { method: 'DELETE' as const, url: '/api/devices/zz-missing', error: 'DEVICE_NOT_FOUND' },
      {
        method: 'PATCH' as const,
        url: '/api/scenarios/zz-missing',
        error: 'SCENARIO_NOT_FOUND',
      },
      {
        method: 'DELETE' as const,
        url: '/api/scenarios/zz-missing',
        error: 'SCENARIO_NOT_FOUND',
      },
    ];

    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        cookies,
        ...(item.method === 'PATCH' ? { payload: {} } : {}),
      });
      expect(response.statusCode, `${item.method} ${item.url}`).toBe(404);
      expect(response.json()).toMatchObject({ error: item.error });
    }
  });

  it('espone anche le singole collezioni', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const rooms = await app.inject({ method: 'GET', url: '/api/rooms', cookies });
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json<{ rooms: unknown[] }>().rooms).toHaveLength(SEED_ROOMS.length);

    const devices = await app.inject({ method: 'GET', url: '/api/devices', cookies });
    expect(devices.statusCode).toBe(200);
    expect(devices.json<{ devices: unknown[] }>().devices).toHaveLength(initialDevices.length);

    const scenarios = await app.inject({ method: 'GET', url: '/api/scenarios', cookies });
    expect(scenarios.statusCode).toBe(200);
    expect(scenarios.json<{ scenarios: unknown[] }>().scenarios).toHaveLength(SCENARIOS.length);
  });
});
