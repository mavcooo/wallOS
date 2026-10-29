import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { Database } from '../db.js';
import type { MqttLink } from '../mqttClient.js';
import { createAlarmManager } from '../services/alarmManager.js';
import {
  createSecurityEventBus,
  type SecurityEventBus,
  type SecurityStateEvent,
} from '../services/securityEvents.js';
import { insertSecurityEvent } from '../services/securityStore.js';
import { hashSecret, randomId } from '../security.js';

/**
 * Criteri di accettazione del sistema di allarme.
 *
 * Ogni test parte da un database PGlite vuoto (schema + seed demo), quindi
 * stato, zone ed eventi sono isolati. Il broker è un finto `MqttLink`: i
 * messaggi si consegnano con `deliver()`, come farebbe mqtt.js, e le
 * sottoscrizioni/publish si ispezionano senza aprire socket.
 */

const PASSWORD = 'admin-password-123';
const ADMIN_PIN = '2468';
const JWT_SECRET = 'test-secret-with-enough-entropy-0123456789abcdef';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

interface FakeLink {
  link: MqttLink;
  subscriptions: Set<string>;
  published: { topic: string; payload: string; retain: boolean }[];
  deliver(topic: string, payload: string): void;
}

function fakeLink(): FakeLink {
  const subscriptions = new Set<string>();
  const published: { topic: string; payload: string; retain: boolean }[] = [];
  let handler: ((topic: string, payload: string) => void) | null = null;

  const link: MqttLink = {
    enabled: true,
    publish(topic, payload, options) {
      published.push({ topic, payload, retain: options?.retain ?? false });
      return true;
    },
    subscribe(topic) {
      subscriptions.add(topic);
    },
    unsubscribe(topic) {
      subscriptions.delete(topic);
    },
    onMessage(next) {
      handler = next;
    },
    close: async () => undefined,
  };

  return {
    link,
    subscriptions,
    published,
    deliver(topic, payload) {
      handler?.(topic, payload);
    },
  };
}

interface SetupResult {
  app: FastifyInstance;
  db: Database;
  broker: FakeLink;
  config: ReturnType<typeof loadConfig>;
  bus: SecurityEventBus;
  /** Worker costruito da `buildApp`: lo stesso che `index.ts` avvia. */
  manager: ReturnType<typeof createAlarmManager>;
  /** Eventi pubblicati sul bus (SSE): ordine di arrivo. */
  events: SecurityStateEvent[];
}

async function setup(): Promise<SetupResult> {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTO_SEED: 'true',
    JWT_SECRET,
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN,
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

  const broker = fakeLink();
  const events: SecurityStateEvent[] = [];
  const bus = createSecurityEventBus();
  const publish = bus.publish.bind(bus);
  bus.publish = (event) => {
    events.push(event);
    publish(event);
  };

  const { app, alarmManager } = await buildApp({
    config,
    db,
    securityLink: broker.link,
    securityEvents: bus,
  });
  openApps.push(app);
  return { app, db, broker, config, bus, events, manager: alarmManager };
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

/** Sensore non presente nel seed: il PIR di un corridoio. */
async function insertMotionSensor(db: Database): Promise<void> {
  await db.client.query(
    `INSERT INTO devices (id, room_id, name, type, adapter, state_topic, metadata)
     VALUES ('sensor-hall-motion', 'living', 'PIR corridoio', 'sensor', 'zigbee2mqtt',
             'zigbee2mqtt/living/motion', '{"state":{"type":"motion"}}'::jsonb)`,
  );
}

async function insertContactSensor(db: Database): Promise<void> {
  await db.client.query(
    `INSERT INTO devices (id, room_id, name, type, adapter, state_topic, metadata)
     VALUES ('sensor-balcony-door', 'living', 'Finestra balcone', 'sensor', 'zigbee2mqtt',
             'zigbee2mqtt/living/balcony', '{"state":{"type":"contact"}}'::jsonb)`,
  );
}

interface SecurityEventDto {
  id: string;
  deviceId: string;
  deviceName: string;
  roomName: string;
  zoneId: string | null;
  eventType: string;
  severity: string;
  triggeredAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  notes: string | null;
}

interface SecurityStateDto {
  state: { status: string; armedAt: string | null; disarmedAt: string | null };
  zones: { id: string; kind: string; sensors: { deviceId: string; eventType: string }[] }[];
  activeEvents: SecurityEventDto[];
  openSensors: { deviceId: string }[];
}

async function securityState(
  app: FastifyInstance,
  cookies: Record<string, string>,
): Promise<SecurityStateDto> {
  const response = await app.inject({ method: 'GET', url: '/api/security/state', cookies });
  expect(response.statusCode).toBe(200);
  return response.json<SecurityStateDto>();
}

async function countEvents(db: Database): Promise<number> {
  const result = await db.client.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM security_events`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe('alarmManager', () => {
  it('registra su PostgreSQL un allarme fumo scattato con tutti i browser chiusi', async () => {
    const { app, db, manager } = await setup();
    await manager.refreshSensors();

    // Nessun client SSE, nessuna sessione browser: solo il worker e il broker.
    await manager.handleMessage('zigbee2mqtt/kitchen/smoke', '{"smoke":true}');

    expect(await countEvents(db)).toBe(1);

    // Il tablet si riaccende: lo stato arriva dalla rete, non da un toast.
    const cookies = await login(app);
    const state = await securityState(app, cookies);
    expect(state.state.status).toBe('TRIGGERED');
    expect(state.activeEvents).toHaveLength(1);
    expect(state.activeEvents[0]?.eventType).toBe('smoke');
    expect(state.activeEvents[0]?.deviceId).toBe('sensor-kitchen-smoke');
    expect(state.activeEvents[0]?.severity).toBe('critical');
    expect(state.activeEvents[0]?.acknowledgedAt).toBeNull();
    expect(state.activeEvents[0]?.resolvedAt).toBeNull();

    // La mappatura automatica ha messo il fumo in zona emergenza 24H.
    const emergency = state.zones.find((zone) => zone.id === 'emergency');
    expect(emergency?.sensors.map((sensor) => sensor.deviceId)).toContain('sensor-kitchen-smoke');
  });

  it('riavvia il gateway senza duplicare l’allarme retained', async () => {
    const { db, broker, config } = await setup();

    const first = createAlarmManager({ db, config, link: broker.link });
    await first.start();
    // Retained all'avvio + riconnessione: lo stesso allarme arriva più volte.
    broker.deliver('zigbee2mqtt/kitchen/smoke', '{"smoke":true}');
    broker.deliver('zigbee2mqtt/kitchen/smoke', '{"smoke":true}');
    await first.handleMessage('zigbee2mqtt/kitchen/smoke', '{"smoke":true}');
    await first.stop();

    // Processo nuovo, stesso database: l'evento aperto è già lì.
    const second = createAlarmManager({ db, config, link: broker.link });
    await second.start();
    await second.handleMessage('zigbee2mqtt/kitchen/smoke', '{"smoke":true}');

    expect(await countEvents(db)).toBe(1);
    expect(second.subscriptions()).toContain('security/#');
    expect(second.subscriptions()).toContain('zigbee2mqtt/kitchen/smoke');
    await second.stop();
  });

  it('due rilevazioni concorrenti producono un solo evento aperto', async () => {
    const { db, manager } = await setup();
    await manager.refreshSensors();

    await Promise.all([
      manager.handleMessage('zigbee2mqtt/kitchen/smoke', '{"smoke":true}'),
      manager.handleMessage('zigbee2mqtt/kitchen/smoke', '{"smoke":true}'),
    ]);

    expect(await countEvents(db)).toBe(1);
  });

  it('i sensori volumetrici suonano solo a impianto armato, ma restano in audit', async () => {
    const { app, db, manager } = await setup();
    await insertMotionSensor(db);
    await manager.refreshSensors();
    const cookies = await login(app);

    // DISARMED: nessun allarme attivo, solo una riga informativa già chiusa.
    await manager.handleMessage('zigbee2mqtt/living/motion', '{"occupancy":true}');
    let state = await securityState(app, cookies);
    expect(state.activeEvents).toHaveLength(0);
    expect(state.state.status).toBe('DISARMED');

    const audit = await db.client.query<{ severity: string; resolved_at: string | null }>(
      `SELECT severity, resolved_at FROM security_events WHERE device_id = 'sensor-hall-motion'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.severity).toBe('info');
    expect(audit.rows[0]?.resolved_at).not.toBeNull();

    // ARMED_AWAY: la zona interna è attiva, la rilevazione diventa allarme.
    const arm = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_AWAY', pin: ADMIN_PIN },
    });
    expect(arm.statusCode).toBe(200);
    expect(arm.json<{ state: { status: string } }>().state.status).toBe('ARMED_AWAY');

    await manager.handleMessage('zigbee2mqtt/living/motion', '{"occupancy":true}');
    state = await securityState(app, cookies);
    expect(state.state.status).toBe('TRIGGERED');
    expect(state.activeEvents[0]?.eventType).toBe('motion');
  });

  it('arm e disarm persistono su DB e richiedono il PIN', async () => {
    const { app, db } = await setup();
    const cookies = await login(app);

    const noPin = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_AWAY' },
    });
    expect(noPin.statusCode).toBe(403);
    expect(noPin.json<{ error: string }>().error).toBe('ELEVATION_REQUIRED');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_AWAY', pin: '9999' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ error: string }>().error).toBe('INVALID_PIN');

    const armed = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_AWAY', pin: ADMIN_PIN },
    });
    expect(armed.statusCode).toBe(200);
    expect(armed.json<{ state: { status: string } }>().state.status).toBe('ARMED_AWAY');

    const persisted = await db.client.query<{ status: string }>(
      `SELECT status FROM security_system_state WHERE id = 'primary'`,
    );
    expect(persisted.rows[0]?.status).toBe('ARMED_AWAY');

    const disarmed = await app.inject({
      method: 'POST',
      url: '/api/security/disarm',
      cookies,
      payload: { pin: ADMIN_PIN },
    });
    expect(disarmed.statusCode).toBe(200);
    expect(disarmed.json<{ state: { status: string } }>().state.status).toBe('DISARMED');

    const after = await db.client.query<{ status: string }>(
      `SELECT status FROM security_system_state WHERE id = 'primary'`,
    );
    expect(after.rows[0]?.status).toBe('DISARMED');
  });

  it('il profilo ospite non può armare nemmeno conoscendo il PIN', async () => {
    const { app, db } = await setup();
    await db.insertUser({
      id: randomId(),
      username: 'ospite',
      displayName: 'Ospite',
      passwordHash: await hashSecret(PASSWORD, 4),
      role: 'guest',
      pinHash: await hashSecret(ADMIN_PIN, 4),
      pinLength: 4,
      isKioskDevice: false,
      kioskDeviceId: null,
      allowedRooms: null,
    });
    const cookies = await session(app, '/api/auth/login', {
      username: 'ospite',
      password: PASSWORD,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_HOME', pin: ADMIN_PIN },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toBe('FORBIDDEN');
  });

  it('rifiuta l’armamento con un contatto aperto e lo accetta dopo la chiusura', async () => {
    const { app, db, manager } = await setup();
    await insertContactSensor(db);
    await manager.refreshSensors();
    const cookies = await login(app);

    await manager.handleMessage('zigbee2mqtt/living/balcony', '{"contact":true}');

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_AWAY', pin: ADMIN_PIN },
    });
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json<{ error: string; blocking: { kind: string }[] }>();
    expect(body.error).toBe('ZONE_NOT_READY');
    expect(body.blocking.map((entry) => entry.kind)).toContain('open_sensor');

    await manager.handleMessage('zigbee2mqtt/living/balcony', '{"contact":false}');

    const armed = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_AWAY', pin: ADMIN_PIN },
    });
    expect(armed.statusCode).toBe(200);
  });

  it('l’ACK timbra l’evento senza chiuderlo, il resolve lo chiude e disarma', async () => {
    const { app, db, manager } = await setup();
    await manager.refreshSensors();
    await manager.handleMessage('zigbee2mqtt/kitchen/smoke', '{"smoke":true}');

    const cookies = await login(app);
    const before = await securityState(app, cookies);
    const eventId = before.activeEvents[0]?.id;
    expect(eventId).toBeDefined();

    const noPin = await app.inject({
      method: 'POST',
      url: `/api/security/events/${eventId}/ack`,
      cookies,
      payload: {},
    });
    expect(noPin.statusCode).toBe(403);

    const ack = await app.inject({
      method: 'POST',
      url: `/api/security/events/${eventId}/ack`,
      cookies,
      payload: { pin: ADMIN_PIN },
    });
    expect(ack.statusCode).toBe(200);
    const acked = ack.json<{ event: SecurityEventDto }>().event;
    expect(acked.acknowledgedAt).not.toBeNull();
    expect(acked.resolvedAt).toBeNull();

    // L'evento resta pendente e visibile: l'ACK non è una cancellazione.
    const stillActive = await securityState(app, cookies);
    expect(stillActive.activeEvents).toHaveLength(1);

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/security/events/${eventId}/resolve`,
      cookies,
      payload: { pin: ADMIN_PIN, notes: 'Fumo rientrato dopo areazione' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<{ event: SecurityEventDto }>().event.resolvedAt).not.toBeNull();
    expect(resolved.json<{ state: { status: string } }>().state.status).toBe('DISARMED');

    // Storico: la riga esiste ancora, con nota e timbri.
    const history = await app.inject({ method: 'GET', url: '/api/security/history', cookies });
    expect(history.statusCode).toBe(200);
    const page = history.json<{ events: SecurityEventDto[] }>();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.id).toBe(eventId);
    expect(page.events[0]?.notes).toBe('Fumo rientrato dopo areazione');
    expect(await countEvents(db)).toBe(1);
  });

  it('lo storico è paginato con cursore keyset', async () => {
    const { app, db } = await setup();
    const cookies = await login(app);

    for (const eventType of ['smoke', 'tamper', 'intrusion'] as const) {
      await insertSecurityEvent(db, {
        deviceId: 'sensor-kitchen-smoke',
        eventType,
        severity: 'critical',
        payload: null,
        resolvedAt: new Date(),
      });
    }

    const first = await app.inject({
      method: 'GET',
      url: '/api/security/history?limit=2',
      cookies,
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{
      events: SecurityEventDto[];
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/api/security/history?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      cookies,
    });
    const secondPage = second.json<{ events: SecurityEventDto[]; hasMore: boolean }>();
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    const ids = new Set([
      ...firstPage.events.map((event) => event.id),
      ...secondPage.events.map((event) => event.id),
    ]);
    expect(ids.size).toBe(3);

    const invalidCursor = await app.inject({
      method: 'GET',
      url: '/api/security/history?cursor=not-a-cursor',
      cookies,
    });
    expect(invalidCursor.statusCode).toBe(400);
  });

  it('solo un admin configura zone e sensori, e il worker applica subito', async () => {
    const { app, db, manager, config } = await setup();
    await insertMotionSensor(db);
    await manager.refreshSensors();
    const cookies = await login(app);

    const emptyPatch = await app.inject({
      method: 'PATCH',
      url: '/api/security/zones/interior',
      cookies,
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);

    const unknownZone = await app.inject({
      method: 'PATCH',
      url: '/api/security/zones/garage',
      cookies,
      payload: { armHome: true },
    });
    expect(unknownZone.statusCode).toBe(404);

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/security/zones/interior',
      cookies,
      payload: { name: 'Interna test', armHome: false },
    });
    expect(patched.statusCode).toBe(200);
    const patchedZones = patched.json<{ zones: { id: string; name: string; armHome: boolean }[] }>();
    expect(patchedZones.zones.find((zone) => zone.id === 'interior')).toMatchObject({
      name: 'Interna test',
      armHome: false,
    });

    // Il kiosk non amministra la configurazione, nemmeno con sessione valida.
    const kioskCookies = await session(app, '/api/auth/kiosk-session', {
      deviceId: config.seed.kioskDeviceId,
      pin: config.seed.kioskPin,
    });
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/security/zones/interior',
      cookies: kioskCookies,
      payload: { armHome: true },
    });
    expect(denied.statusCode).toBe(403);

    // Zona interna disattivata in HOME: il PIR non deve scattare.
    const armHome = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_HOME', pin: ADMIN_PIN },
    });
    expect(armHome.statusCode).toBe(200);
    await manager.handleMessage('zigbee2mqtt/living/motion', '{"occupancy":true}');
    expect((await securityState(app, cookies)).activeEvents).toHaveLength(0);

    // Spostato nel perimetro e armato fuori: la stessa rilevazione scatta.
    const moved = await app.inject({
      method: 'PATCH',
      url: '/api/security/sensors/sensor-hall-motion',
      cookies,
      payload: { zoneId: 'perimeter' },
    });
    expect(moved.statusCode).toBe(200);

    const missingSensor = await app.inject({
      method: 'PATCH',
      url: '/api/security/sensors/sensor-unknown',
      cookies,
      payload: { zoneId: 'perimeter' },
    });
    expect(missingSensor.statusCode).toBe(404);

    await app.inject({
      method: 'POST',
      url: '/api/security/disarm',
      cookies,
      payload: { pin: ADMIN_PIN },
    });
    const armAway = await app.inject({
      method: 'POST',
      url: '/api/security/arm',
      cookies,
      payload: { mode: 'ARMED_AWAY', pin: ADMIN_PIN },
    });
    expect(armAway.statusCode).toBe(200);

    await manager.handleMessage('zigbee2mqtt/living/motion', '{"occupancy":true}');
    const state = await securityState(app, cookies);
    expect(state.activeEvents).toHaveLength(1);
    expect(state.activeEvents[0]?.zoneId).toBe('perimeter');
  });

  it('accetta un trigger esterno su security/trigger per un device censito', async () => {
    const { app, db, manager } = await setup();
    await manager.refreshSensors();
    const cookies = await login(app);

    await manager.handleMessage(
      'security/trigger',
      JSON.stringify({
        deviceId: 'sensor-kitchen-smoke',
        eventType: 'smoke',
        payload: { smoke: true },
      }),
    );
    await manager.handleMessage(
      'security/trigger',
      JSON.stringify({ deviceId: 'ghost-device', eventType: 'smoke' }),
    );

    const state = await securityState(app, cookies);
    expect(state.activeEvents).toHaveLength(1);
    expect(await countEvents(db)).toBe(1);
  });

  it('pubblica lo stato retained sul broker e notifica il bus SSE', async () => {
    const { broker, manager, events } = await setup();
    await manager.start();

    // Snapshot iniziale retained: chi si collega dopo un blackout vede lo stato.
    const initial = broker.published.filter(
      (entry) => entry.topic === 'security/alarm_state' && entry.retain,
    );
    expect(initial.length).toBeGreaterThan(0);
    expect(initial[0]?.payload).toContain('DISARMED');

    await manager.handleMessage('zigbee2mqtt/kitchen/smoke', '{"smoke":true}');

    expect(events.map((event) => event.type)).toContain('triggered');
    expect(events.at(-1)?.status).toBe('TRIGGERED');
    expect(events.at(-1)?.deviceId).toBe('sensor-kitchen-smoke');

    const triggered = broker.published.filter(
      (entry) => entry.topic === 'security/alarm_state' && entry.payload.includes('TRIGGERED'),
    );
    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.retain).toBe(true);

    await manager.stop();
  });

  it('non crea eventi per la telemetria normale dei sensori', async () => {
    const { db, manager } = await setup();
    await manager.refreshSensors();

    await manager.handleMessage('zigbee2mqtt/kitchen/smoke', '{"battery":92,"linkquality":80}');
    await manager.handleMessage('zigbee2mqtt/kitchen/smoke', '{"temperature":21.5}');

    expect(await countEvents(db)).toBe(0);
  });

  it('protegge lo stato con la sessione e rifiuta lo stream senza credenziali', async () => {
    const { app } = await setup();

    const state = await app.inject({ method: 'GET', url: '/api/security/state' });
    expect(state.statusCode).toBe(401);

    const stream = await app.inject({ method: 'GET', url: '/api/security/stream' });
    expect(stream.statusCode).toBe(401);
  });
});
