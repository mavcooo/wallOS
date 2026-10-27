import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import type { MqttLink } from './mqttClient.js';
import type { AuthConfig } from './types.js';

const PASSWORD = 'admin-password-123';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

function fakeLink() {
  const published: { topic: string; payload: string }[] = [];
  const subscribed = new Set<string>();
  const link: MqttLink = {
    enabled: true,
    publish(topic, payload) {
      published.push({ topic, payload });
      return true;
    },
    subscribe(topic) {
      subscribed.add(topic);
    },
    unsubscribe(topic) {
      subscribed.delete(topic);
    },
    onMessage: () => undefined,
    close: async () => undefined,
  };
  return { published, subscribed, link };
}

async function setup(): Promise<{
  app: FastifyInstance;
  config: AuthConfig;
  db: Database;
  mqtt: ReturnType<typeof fakeLink>;
}> {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_PIN: '2468',
    KIOSK_PIN: '1234',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    AUTOMATION_LATITUDE: '41.9028',
    AUTOMATION_LONGITUDE: '12.4964',
    AUTOMATION_PRESENCE_TOPIC: 'stat/presence/home',
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

  const mqtt = fakeLink();
  const { app } = await buildApp({ config, db, mqttLink: mqtt.link });
  openApps.push(app);
  return { app, config, db, mqtt };
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

const RULE_BODY = {
  name: 'Luce corridoio di notte',
  description: 'Movimento in soggiorno fra le 23:00 e le 06:00',
  triggerType: 'mqtt_state',
  triggerConfig: {
    topic: 'stat/sensore_soggiorno/MOTION',
    payloadKey: 'occupancy',
    expectedValue: true,
  },
  conditions: [
    { type: 'time_range', start: '23:00', end: '6:00' },
    { type: 'user_present', requireHome: true },
  ],
  // Nessun `type`: è la forma delle regole create prima della migrazione 005 e
  // deve restare accettata (viene normalizzata a `mqtt`).
  actions: [{ topic: 'cmnd/light_corridoio/dimmer', payload: '10', delayMs: 0 }],
};

type AutomationJson = {
  id: string;
  name: string;
  isActive: boolean;
  invalidReason: string | null;
  summary: string;
  triggerConfig: Record<string, unknown>;
  conditions: { type: string; start?: string }[];
  conditionGroups: { type: string }[][];
  actions: { type: string; topic?: string; payload?: string; scenarioId?: string; delayMs: number }[];
  lastRun: { conditionsMet: boolean; executionTimeMs: number } | null;
};

async function createRule(
  app: FastifyInstance,
  cookies: Record<string, string>,
  body: unknown = RULE_BODY,
): Promise<AutomationJson> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/automations',
    cookies,
    payload: body as Record<string, unknown>,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { automation: AutomationJson }).automation;
}

describe('automazioni · autorizzazione', () => {
  it('richiede una sessione per leggere la lista', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/automations' });
    expect(response.statusCode).toBe(401);
  });

  it('il pannello kiosk legge le regole ma non le modifica', async () => {
    const { app } = await setup();
    const kioskResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/kiosk-session',
      payload: { deviceId: 'wall-panel-1', pin: '1234' },
    });
    const cookies = cookiesOf(kioskResponse);

    expect((await app.inject({ method: 'GET', url: '/api/automations', cookies })).statusCode).toBe(
      200,
    );
    const create = await app.inject({
      method: 'POST',
      url: '/api/automations',
      cookies,
      payload: RULE_BODY,
    });
    expect(create.statusCode).toBe(403);
  });
});

describe('automazioni · CRUD', () => {
  it('crea una regola, la normalizza e la restituisce nella lista', async () => {
    const { app, mqtt } = await setup();
    const cookies = await login(app);

    const created = await createRule(app, cookies);
    expect(created.name).toBe('Luce corridoio di notte');
    expect(created.isActive).toBe(true);
    expect(created.invalidReason).toBeNull();
    expect(created.conditions[0]).toMatchObject({ type: 'time_range', start: '23:00', end: '06:00' });
    expect(created.conditionGroups).toEqual([]);
    expect(created.actions).toEqual([
      { type: 'mqtt', topic: 'cmnd/light_corridoio/dimmer', payload: '10', delayMs: 0 },
    ]);
    // La cache del motore si è riallineata: il topic è sottoscritto.
    expect(mqtt.subscribed.has('stat/sensore_soggiorno/MOTION')).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/automations', cookies });
    expect(list.statusCode).toBe(200);
    const automations = (list.json() as { automations: AutomationJson[] }).automations;
    expect(automations).toHaveLength(1);
    expect(automations[0]?.id).toBe(created.id);
    expect(automations[0]?.lastRun).toBeNull();
  });

  it('aggiorna e poi elimina una regola', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const created = await createRule(app, cookies);

    const update = await app.inject({
      method: 'PUT',
      url: `/api/automations/${created.id}`,
      cookies,
      payload: {
        ...RULE_BODY,
        name: 'Luce corridoio (aggiornata)',
        triggerType: 'time_cron',
        triggerConfig: { cron: '30 22 * * 1-5' },
        conditions: [],
        actions: [{ topic: 'cmnd/light_corridoio/POWER', payload: 'ON' }],
      },
    });
    expect(update.statusCode).toBe(200);
    const updated = (update.json() as { automation: AutomationJson }).automation;
    expect(updated.name).toBe('Luce corridoio (aggiornata)');
    expect(updated.summary).toContain('30 22 * * 1-5');
    expect(updated.actions).toEqual([
      { type: 'mqtt', topic: 'cmnd/light_corridoio/POWER', payload: 'ON', delayMs: 0 },
    ]);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/automations/${created.id}`,
      cookies,
    });
    expect(remove.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/api/automations', cookies });
    expect((list.json() as { automations: unknown[] }).automations).toEqual([]);
  });

  it('salva i gruppi di condizioni in OR e li restituisce nella lista', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const created = await createRule(app, cookies, {
      ...RULE_BODY,
      conditions: [{ type: 'time_range', start: '23:00', end: '06:00' }],
      conditionGroups: [
        [{ type: 'user_present', requireHome: true }],
        [{ type: 'device_state', deviceId: 'light-living-main', expectedState: 'ON' }],
      ],
    });

    expect(created.invalidReason).toBeNull();
    expect(created.conditionGroups).toEqual([
      [{ type: 'user_present', requireHome: true }],
      [{ type: 'device_state', deviceId: 'light-living-main', expectedState: 'ON' }],
    ]);

    // La persistenza passa dalla colonna `condition_groups`, non solo dal DTO.
    const rows = await app.inject({ method: 'GET', url: '/api/automations', cookies });
    const listed = (rows.json() as { automations: AutomationJson[] }).automations[0];
    expect(listed?.conditionGroups).toHaveLength(2);
  });

  it('accetta un’azione di scenario se lo scenario esiste', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const scenarios = await app.inject({ method: 'GET', url: '/api/topology', cookies });
    const first = (
      scenarios.json() as { scenarios: { id: string; label: string }[] }
    ).scenarios[0];
    if (!first) throw new Error('nessuno scenario nel seed');

    const created = await createRule(app, cookies, {
      ...RULE_BODY,
      conditions: [],
      actions: [{ type: 'scenario', scenarioId: first.id, delayMs: 250 }],
    });

    expect(created.invalidReason).toBeNull();
    expect(created.actions).toEqual([
      { type: 'scenario', scenarioId: first.id, delayMs: 250 },
    ]);
    expect(created.summary).toMatch(/mqtt_state/);
  });

  it('rifiuta un’azione di scenario che punta a uno scenario inesistente', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/automations',
      cookies,
      payload: {
        ...RULE_BODY,
        actions: [{ type: 'scenario', scenarioId: 'scenario-sparito' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('SCENARIO_NOT_FOUND');
  });

  it('disattiva e riattiva con il toggle rapido', async () => {
    const { app, mqtt } = await setup();
    const cookies = await login(app);
    const created = await createRule(app, cookies);

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/automations/${created.id}/toggle`,
      cookies,
      payload: { isActive: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { automation: AutomationJson }).automation.isActive).toBe(false);
    // Disattivata: la cache non la contiene più e il topic non è più ascoltato.
    expect(mqtt.subscribed.has('stat/sensore_soggiorno/MOTION')).toBe(false);

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/automations/${created.id}/toggle`,
      cookies,
    });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { automation: AutomationJson }).automation.isActive).toBe(true);
    expect(mqtt.subscribed.has('stat/sensore_soggiorno/MOTION')).toBe(true);
  });

  it('404 su una regola inesistente e su un id non valido', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const missing = '99999999-9999-4999-8999-999999999999';

    for (const url of [
      `/api/automations/${missing}`,
      '/api/automations/non-un-uuid',
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url,
        cookies,
        payload: RULE_BODY,
      });
      expect(response.statusCode).toBe(404);
    }

    const logs = await app.inject({ method: 'GET', url: `/api/automations/${missing}/logs`, cookies });
    expect(logs.statusCode).toBe(404);
  });
});

describe('automazioni · validazione', () => {
  it('rifiuta trigger, condizioni e azioni malformati', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const cases: [Partial<Record<string, unknown>>, RegExp][] = [
      [{ triggerType: 'mqtt_state', triggerConfig: { topic: 'stat/+/bad#topic' } }, /topic/i],
      [{ triggerType: 'mqtt_state', triggerConfig: { topic: 'stat/x', payloadKey: '' } }, /payloadKey|topic/i],
      [{ triggerType: 'time_cron', triggerConfig: { cron: '0 23 * *' } }, /cron/i],
      [{ triggerType: 'time_cron', triggerConfig: { cron: '99 23 * * *' } }, /cron/i],
      [{ triggerType: 'sun_event', triggerConfig: { event: 'noon' } }, /event|sun/i],
      [{ triggerType: 'sun_event', triggerConfig: { event: 'sunrise', offsetMinutes: 5000 } }, /offsetMinutes|too/i],
      [{ conditions: [{ type: 'time_range', start: '25:00', end: '06:00' }] }, /Orario/],
      [{ conditions: [{ type: 'device_state', deviceId: '' }] }, /deviceId|expectedState/],
      [{ conditionGroups: [[{ type: 'boh' }]] }, /type|invalid/i],
      [{ conditionGroups: [[]] }, /conditionGroups|Too small|at least/i],
      [{ actions: [{ type: 'scenario', scenarioId: '' }] }, /scenarioId|Too small/i],
      [{ actions: [{ topic: 'cmnd/light/+', payload: 'ON' }] }, /topic/i],
      [{ actions: [] }, /actions|Too small|at least/i],
      [{ name: '' }, /name|Too small/i],
    ];

    for (const [patch, expected] of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/automations',
        cookies,
        payload: { ...RULE_BODY, ...patch },
      });
      expect(response.statusCode, JSON.stringify(patch)).toBe(400);
      expect(
        `${(response.json() as { message: string }).message} ${(response.json() as { field?: string }).field ?? ''}`,
      ).toMatch(expected);
    }
  });

  it('una regola senza coordinate solari si salva ma resta inerte e spiegata', async () => {
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
    const { app } = await buildApp({ config, db, mqttLink: fakeLink().link });
    openApps.push(app);
    const cookies = await login(app);

    const created = await createRule(app, cookies, {
      ...RULE_BODY,
      name: 'Tramonto',
      triggerType: 'sun_event',
      triggerConfig: { event: 'sunset', offsetMinutes: -15 },
    });

    expect(created.invalidReason).toMatch(/AUTOMATION_LATITUDE/);
    expect(created.summary).toMatch(/inerte/);
  });
});

describe('automazioni · esecuzione di prova e log', () => {
  it('il test forzato pubblica i comandi e finisce nello storico', async () => {
    const { app, mqtt } = await setup();
    const cookies = await login(app);
    const created = await createRule(app, cookies);

    const test = await app.inject({
      method: 'POST',
      url: `/api/automations/${created.id}/test`,
      cookies,
    });

    expect(test.statusCode).toBe(201);
    const execution = (
      test.json() as {
        execution: { triggerSource: string; conditionsMet: boolean; error: string | null };
      }
    ).execution;
    expect(execution.triggerSource).toBe('test');
    expect(execution.conditionsMet).toBe(true);
    expect(execution.error).toBeNull();
    expect(mqtt.published).toEqual([{ topic: 'cmnd/light_corridoio/dimmer', payload: '10' }]);

    const logs = await app.inject({
      method: 'GET',
      url: `/api/automations/${created.id}/logs?limit=5`,
      cookies,
    });
    expect(logs.statusCode).toBe(200);
    const entries = (
      logs.json() as {
        logs: { triggerSource: string; conditionsMet: boolean; actions: unknown }[];
      }
    ).logs;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.triggerSource).toBe('test');
    expect(entries[0]?.conditionsMet).toBe(true);
  });

  it('espone quale automazione ha comandato un dispositivo', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    // Il topic di comando del device del seed: il motore risale dal topic al device.
    const created = await createRule(app, cookies, {
      ...RULE_BODY,
      conditions: [],
      actions: [{ type: 'mqtt', topic: 'zigbee2mqtt/living/main/set', payload: '{"state":"ON"}' }],
    });

    const empty = await app.inject({ method: 'GET', url: '/api/automations/activity', cookies });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { activity: unknown[] }).activity).toEqual([]);

    await app.inject({
      method: 'POST',
      url: `/api/automations/${created.id}/test`,
      cookies,
    });

    const activity = await app.inject({
      method: 'GET',
      url: '/api/automations/activity',
      cookies,
    });
    expect(activity.statusCode).toBe(200);
    expect((activity.json() as { activity: Record<string, unknown>[] }).activity).toEqual([
      expect.objectContaining({
        deviceId: 'light-living-main',
        automationId: created.id,
        automationName: 'Luce corridoio di notte',
        triggerSource: 'test',
        scenarioLabel: null,
        topic: 'zigbee2mqtt/living/main/set',
      }),
    ]);
  });

  it('la lista espone lo stato dell’ultima esecuzione', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const created = await createRule(app, cookies);

    await app.inject({
      method: 'POST',
      url: `/api/automations/${created.id}/test`,
      cookies,
    });

    const list = await app.inject({ method: 'GET', url: '/api/automations', cookies });
    const automation = (
      list.json() as {
        automations: { lastRun: { conditionsMet: boolean; executionTimeMs: number } | null }[];
      }
    ).automations[0];
    expect(automation?.lastRun?.conditionsMet).toBe(true);
    expect(automation?.lastRun?.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('lo storico è limitato alle ultime esecuzioni', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const created = await createRule(app, cookies);

    for (let index = 0; index < 3; index += 1) {
      await app.inject({
        method: 'POST',
        url: `/api/automations/${created.id}/test`,
        cookies,
      });
    }

    const logs = await app.inject({
      method: 'GET',
      url: `/api/automations/${created.id}/logs?limit=2`,
      cookies,
    });
    expect((logs.json() as { logs: unknown[] }).logs).toHaveLength(2);
  });
});
