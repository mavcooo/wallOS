import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import type { TopologyChangedEvent, TopologyEventBus } from './services/topologyEvents.js';

const PASSWORD = 'admin-password-123';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

/** Bus falso: registra gli eventi pubblicati dopo il commit. */
function spyBus(): TopologyEventBus & { events: TopologyChangedEvent[] } {
  const events: TopologyChangedEvent[] = [];
  return {
    events,
    publish(event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    async close() {},
  };
}

async function setup(): Promise<{ app: FastifyInstance; events: TopologyChangedEvent[] }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTO_SEED: 'true',
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

  const bus = spyBus();
  const { app } = await buildApp({ config, db, topologyEvents: bus });
  openApps.push(app);
  return { app, events: bus.events };
}

async function session(
  app: FastifyInstance,
  path: '/api/auth/login' | '/api/auth/kiosk-session',
  payload: Record<string, string>,
): Promise<Record<string, string>> {
  const response = await app.inject({ method: 'POST', url: path, payload });
  expect(response.statusCode).toBe(200);

  const cookies: Record<string, string> = {};
  for (const header of response.headers['set-cookie'] ?? []) {
    const pair = String(header).split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return cookies;
}

const login = (app: FastifyInstance) =>
  session(app, '/api/auth/login', { username: 'admin', password: PASSWORD });

interface FloorDto {
  id: string;
  name: string;
  levelOrder: number;
  rooms: {
    id: string;
    label: string;
    floorId: string | null;
    gridLayout: { col: number; row: number; colSpan: number; rowSpan: number; color: string };
    devices: { id: string; kind: string; roomPinPosition: { x: number; y: number } }[];
  }[];
}

describe('planimetria multi-piano', () => {
  it('richiede una sessione per leggere i piani', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/floors' });
    expect(response.statusCode).toBe(401);
  });

  it('restituisce piani ordinati con stanze, geometrie e marker', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({ method: 'GET', url: '/api/floors', cookies });
    expect(response.statusCode).toBe(200);

    const { floors } = response.json<{ floors: FloorDto[] }>();
    expect(floors.map((floor) => floor.id)).toEqual(['piano-terra', 'primo-piano']);
    expect(floors.map((floor) => floor.levelOrder)).toEqual([0, 1]);

    const living = floors[0]?.rooms.find((room) => room.id === 'living');
    expect(living).toMatchObject({
      label: 'Soggiorno',
      floorId: 'piano-terra',
      gridLayout: { col: 1, row: 1, colSpan: 5, rowSpan: 4, color: 'amber' },
    });

    const light = living?.devices.find((device) => device.id === 'light-living-main');
    expect(light).toBeDefined();
    expect(light?.roomPinPosition.x).toBeGreaterThanOrEqual(0);
    expect(light?.roomPinPosition.y).toBeLessThanOrEqual(100);

    // Le stanze del seed sono distribuite: il primo piano non è vuoto.
    expect(floors[1]?.rooms.map((room) => room.id)).toEqual(
      expect.arrayContaining(['bedroom', 'study', 'bath']),
    );
  });

  it('crea, rinomina ed elimina un piano; le stanze restano senza piano', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/floors',
      cookies,
      headers: { 'x-client-id': 'admin-pc' },
      payload: { name: 'Soppalco', levelOrder: 2, icon: 'Layers' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ floor: FloorDto }>().floor).toMatchObject({
      id: 'soppalco',
      name: 'Soppalco',
      levelOrder: 2,
      rooms: [],
    });
    expect(events.at(-1)).toMatchObject({
      event: 'floor_created',
      entity: 'floor',
      id: 'soppalco',
      sourceClientId: 'admin-pc',
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/floors',
      cookies,
      payload: { name: 'Soppalco' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'FLOOR_EXISTS' });

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/floors/soppalco',
      cookies,
      payload: { name: 'Soppalco abitabile', levelOrder: 3 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ floor: FloorDto }>().floor).toMatchObject({
      name: 'Soppalco abitabile',
      levelOrder: 3,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/floors/piano-terra',
      cookies,
    });
    expect(deleted.statusCode).toBe(204);

    // FK `ON DELETE SET NULL`: le stanze non vengono eliminate con il piano.
    const topology = await app.inject({ method: 'GET', url: '/api/topology', cookies });
    const rooms = topology.json<{ rooms: { id: string; floorId: string | null }[] }>().rooms;
    expect(rooms.find((room) => room.id === 'living')?.floorId).toBeNull();
  });

  it('salva geometrie e marker in una transazione e pubblica floor_updated', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/floors/piano-terra/layout',
      cookies,
      headers: { 'x-client-id': 'tablet-admin' },
      payload: {
        rooms: [
          {
            id: 'living',
            gridLayout: { col: 2, row: 1, colSpan: 4, rowSpan: 3, color: 'teal' },
          },
          {
            // Associazione: la cucina passa al primo piano.
            id: 'kitchen',
            floorId: 'primo-piano',
            gridLayout: { col: 1, row: 5, colSpan: 4, rowSpan: 3, color: 'sky' },
          },
        ],
        devices: [
          { id: 'light-living-main', roomPinPosition: { x: 12, y: 88 } },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    // piano-terra conserva living, outdoor e unassigned; la cucina è salita.
    expect(response.json<{ floor: FloorDto }>().floor.rooms.map((room) => room.id)).toEqual([
      'living',
      'unassigned',
      'outdoor',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'floor_updated',
      entity: 'floor',
      id: 'piano-terra',
      sourceClientId: 'tablet-admin',
    });

    // Rilette entrambe le viste: piani (annidata) e topologia (piatta).
    const floors = await app.inject({ method: 'GET', url: '/api/floors', cookies });
    const body = floors.json<{ floors: FloorDto[] }>().floors;
    const primoPiano = body.find((floor) => floor.id === 'primo-piano');
    expect(primoPiano?.rooms.find((room) => room.id === 'kitchen')).toMatchObject({
      floorId: 'primo-piano',
      gridLayout: { col: 1, row: 5, colSpan: 4, rowSpan: 3, color: 'sky' },
    });

    const topology = await app.inject({ method: 'GET', url: '/api/topology', cookies });
    const snapshot = topology.json<{
      rooms: { id: string; floorId: string | null; gridLayout: { color: string } }[];
      devices: { id: string; roomPinPosition: { x: number; y: number } }[];
    }>();
    expect(snapshot.rooms.find((room) => room.id === 'living')).toMatchObject({
      floorId: 'piano-terra',
      gridLayout: { color: 'teal' },
    });
    expect(snapshot.devices.find((device) => device.id === 'light-living-main')).toMatchObject({
      roomPinPosition: { x: 12, y: 88 },
    });
  });

  it('rifiuta payload fuori griglia e id sconosciuti senza scrivere nulla', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    const outsideGrid = await app.inject({
      method: 'PUT',
      url: '/api/floors/piano-terra/layout',
      cookies,
      payload: {
        rooms: [
          {
            id: 'living',
            gridLayout: { col: 11, row: 1, colSpan: 4, rowSpan: 3, color: 'teal' },
          },
        ],
        devices: [],
      },
    });
    expect(outsideGrid.statusCode).toBe(400);
    expect(outsideGrid.json()).toMatchObject({ error: 'INVALID_BODY' });

    const unknownDevice = await app.inject({
      method: 'PUT',
      url: '/api/floors/piano-terra/layout',
      cookies,
      payload: {
        rooms: [
          {
            id: 'living',
            gridLayout: { col: 2, row: 2, colSpan: 2, rowSpan: 2, color: 'zinc' },
          },
        ],
        devices: [{ id: 'light-inesistente', roomPinPosition: { x: 10, y: 10 } }],
      },
    });
    expect(unknownDevice.statusCode).toBe(400);
    expect(unknownDevice.json()).toMatchObject({ error: 'DEVICE_NOT_FOUND' });
    expect(events).toHaveLength(0);

    // La geometria valida della prima richiesta non è mai stata applicata.
    const topology = await app.inject({ method: 'GET', url: '/api/topology', cookies });
    const living = topology
      .json<{ rooms: { id: string; gridLayout: { col: number; color: string } }[] }>()
      .rooms.find((room) => room.id === 'living');
    expect(living?.gridLayout).toMatchObject({ col: 1, color: 'amber' });
  });

  it('riserva le mutazioni all’amministratore', async () => {
    const { app } = await setup();
    const kiosk = await session(app, '/api/auth/kiosk-session', {
      deviceId: 'wall-panel-1',
      pin: '1234',
    });

    const read = await app.inject({ method: 'GET', url: '/api/floors', cookies: kiosk });
    expect(read.statusCode).toBe(200);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/floors',
      cookies: kiosk,
      payload: { name: 'Garage' },
    });
    expect(forbidden.statusCode).toBe(403);

    const forbiddenLayout = await app.inject({
      method: 'PUT',
      url: '/api/floors/piano-terra/layout',
      cookies: kiosk,
      payload: { rooms: [], devices: [] },
    });
    expect(forbiddenLayout.statusCode).toBe(403);
  });
});
