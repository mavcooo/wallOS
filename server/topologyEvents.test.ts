import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import {
  createTopologyEventBus,
  resolveTopologyTopic,
  type TopologyChangedEvent,
  type TopologyEventBus,
} from './services/topologyEvents.js';

const PASSWORD = 'admin-password-123';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

/** Bus falso: registra gli eventi e li inoltra ai subscriber SSE. */
function spyBus(): TopologyEventBus & { events: TopologyChangedEvent[] } {
  const events: TopologyChangedEvent[] = [];
  const listeners = new Set<(event: TopologyChangedEvent) => void>();
  return {
    events,
    publish(event) {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {},
  };
}

async function setup(): Promise<{ app: FastifyInstance; events: TopologyChangedEvent[] }> {
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

  const events = spyBus();
  const { app } = await buildApp({ config, db, topologyEvents: events });
  openApps.push(app);
  return { app, events: events.events };
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

describe('eventi di topologia pubblicati post-commit', () => {
  it('annuncia l\'aggiornamento di una stanza con l\'id del client che lo ha generato', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/rooms/living',
      cookies,
      headers: { 'x-client-id': 'admin-pc' },
      payload: { name: 'Salotto', shortLabel: 'Salotto', icon: 'sofa' },
    });
    expect(response.statusCode).toBe(200);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'room_updated',
      entity: 'room',
      id: 'living',
      sourceClientId: 'admin-pc',
    });
    expect(events[0]?.timestamp).toBeGreaterThan(0);

    // Anche la lettura torna coerente con l'evento appena emesso.
    const read = await app.inject({ method: 'GET', url: '/api/rooms', cookies });
    const rooms = read.json<{ rooms: { id: string; label: string }[] }>().rooms;
    expect(rooms.find((room) => room.id === 'living')?.label).toBe('Salotto');
  });

  it('distingue il riordino dall\'aggiornamento', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    // living ha displayOrder 0 nel seed: un ordine diverso è un riordino.
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/rooms/living',
      cookies,
      payload: { name: 'Soggiorno', displayOrder: 7 },
    });
    expect(response.statusCode).toBe(200);
    expect(events.map((event) => event.event)).toEqual(['room_reordered']);
  });

  it('annuncia creazione e cancellazione di un dispositivo', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/devices',
      cookies,
      payload: {
        id: 'lampada-prova',
        name: 'Lampada Prova',
        roomId: 'living',
        stateTopic: 'zigbee2mqtt/prova',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(events[0]).toMatchObject({
      event: 'device_created',
      entity: 'device',
      id: 'lampada-prova',
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/devices/lampada-prova',
      cookies,
    });
    expect(removed.statusCode).toBe(204);
    expect(events.map((event) => event.event)).toEqual([
      'device_created',
      'device_deleted',
    ]);
  });

  it('non pubblica nulla quando la mutazione fallisce', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/rooms/inesistente',
      cookies,
      payload: { name: 'Fantasma' },
    });
    expect(missing.statusCode).toBe(404);

    const forbidden = await app.inject({ method: 'DELETE', url: '/api/rooms/living', cookies });
    expect(forbidden.statusCode).toBe(409);

    expect(events).toHaveLength(0);
  });

  it('omette sourceClientId quando il client non manda l\'header', async () => {
    const { app, events } = await setup();
    const cookies = await login(app);

    await app.inject({
      method: 'PATCH',
      url: '/api/rooms/kitchen',
      cookies,
      // displayOrder invariato (1 nel seed): l'evento è un aggiornamento.
      payload: { name: 'Cucina grande', displayOrder: 1 },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'room_updated', id: 'kitchen' });
    expect(events[0]).not.toHaveProperty('sourceClientId');
  });
});

describe('topic e bus degli eventi', () => {
  it('applica il base topic con la stessa normalizzazione del client', () => {
    expect(resolveTopologyTopic('')).toBe('wallos/system/topology_changed');
    expect(resolveTopologyTopic('casa/piano1')).toBe(
      'casa/piano1/wallos/system/topology_changed',
    );
    expect(resolveTopologyTopic('/casa/')).toBe('casa/wallos/system/topology_changed');
  });

  it('senza broker configurato la pubblicazione resta un no-op', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_PIN: '2468',
      KIOSK_PIN: '1234',
      BCRYPT_ROUNDS: '4',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    });
    expect(config.mqtt.url).toBeNull();

    const bus = createTopologyEventBus(config);
    expect(() =>
      bus.publish({ event: 'room_updated', entity: 'room', id: 'living', timestamp: Date.now() }),
    ).not.toThrow();
    await expect(bus.close()).resolves.toBeUndefined();
  });
});

/** Lettura del flusso fino a un frammento atteso, con timeout esplicito. */
type ChunkReader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };

/** `Response.body` è uno ReadableStream web: il reader va estratto con `getReader()`. */
function bodyReader(response: Response): ChunkReader {
  const body = response.body as unknown as { getReader(): ChunkReader } | null;
  if (!body) throw new Error('corpo dello stream assente');
  return body.getReader();
}

async function readUntil(reader: ChunkReader, needle: string, timeoutMs = 5_000): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  while (!buffer.includes(needle)) {
    const remaining = deadline - Date.now();
    const reason = `timeout dopo ${timeoutMs}ms: atteso ${JSON.stringify(needle)} · letto ${JSON.stringify(buffer)}`;
    if (remaining <= 0) throw new Error(reason);
    const result: { done: boolean; value?: Uint8Array } = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(reason)), remaining),
      ),
    ]);
    if (result.done) throw new Error(`stream chiuso: ${reason}`);
    buffer += decoder.decode(result.value, { stream: true });
  }
  return buffer;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

describe('ripiego SSE /api/topology/events', () => {
  it('eroga lo stream e inoltra le mutazioni appena confermate', async () => {
    const { app } = await setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('porta del server non disponibile');
    const origin = `http://127.0.0.1:${address.port}`;
    const cookie = cookieHeader(await login(app));

    const controller = new AbortController();
    try {
      const stream = await fetch(`${origin}/api/topology/events`, {
        headers: { cookie },
        signal: controller.signal,
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const reader = bodyReader(stream);

      // Il primo frame dice al browser quando riprovare in caso di disconnessione.
      expect(await readUntil(reader, 'retry: 3000')).toContain('retry: 3000');

      // Mutazione reale via API: lo stesso payload del bus arriva sul flusso.
      const created = await fetch(`${origin}/api/devices`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-client-id': 'admin-pc',
        },
        body: JSON.stringify({
          id: 'lampada-sse',
          name: 'Lampada SSE',
          roomId: 'living',
          stateTopic: 'zigbee2mqtt/sse',
        }),
      });
      expect(created.status).toBe(201);

      const frame = await readUntil(reader, '"device_created"');
      expect(frame).toContain('data: {');
      expect(frame).toContain('"entity":"device"');
      expect(frame).toContain('"id":"lampada-sse"');
      expect(frame).toContain('"sourceClientId":"admin-pc"');
    } finally {
      controller.abort();
    }
  });

  it('richiede una sessione valida', async () => {
    const { app } = await setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('porta del server non disponibile');

    const controller = new AbortController();
    try {
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/api/topology/events`,
        { signal: controller.signal },
      );
      expect(stream.status).toBe(401);
      await stream.body?.cancel();
    } finally {
      controller.abort();
    }
  });
});
