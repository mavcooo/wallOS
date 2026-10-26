import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { createClimateScheduler } from './services/climateScheduler.js';
import type { AuthConfig } from './types.js';

const PASSWORD = 'admin-password-123';
const DEVICE = 'climate-living';
const LIGHT = 'light-living-main';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

async function setup(): Promise<{ app: FastifyInstance; config: AuthConfig; db: Database }> {
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
  return { app, config, db };
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

/** Fascia che parte domani alle 06:00: sempre nel futuro, qualunque sia l'ora. */
function tomorrowAt(hours: number): { dayOfWeek: number; startTime: string } {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    dayOfWeek: tomorrow.getDay(),
    startTime: `${String(hours).padStart(2, '0')}:00`,
  };
}

describe('cronotermostato · lettura', () => {
  it('richiede una sessione', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: `/api/climate/${DEVICE}/schedules` });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('schedules');
  });

  it('parte senza programma e senza override', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['deviceName']).toBeTruthy();
    expect(body['schedules']).toEqual([]);
    expect(body['activeSchedule']).toBeNull();
    expect(body['nextChangeAt']).toBeNull();
    expect(body['runtime']).toMatchObject({ override: null, vacation: null });
  });

  it('un dispositivo che non è un cronotermostato non ha un programma', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/climate/${LIGHT}/schedules`,
      cookies,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('cronotermostato · salvataggio fasce', () => {
  it('salva la settimana in blocco e la restituisce normalizzata', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const save = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          { dayOfWeek: 1, startTime: '06:00', endTime: '08:30', targetTemp: 20.5, preset: 'comfort' },
          { dayOfWeek: 1, startTime: '18:00', endTime: '24:00', targetTemp: 19, preset: 'eco' },
          { dayOfWeek: 0, startTime: '00:00', endTime: '24:00', targetTemp: 10, preset: 'off' },
        ],
      },
    });

    expect(save.statusCode).toBe(200);
    const saved = save.json() as { schedules: { startTime: string; endTime: string }[] };
    expect(saved.schedules).toHaveLength(3);
    expect(saved.schedules.map((schedule) => schedule.endTime)).toContain('24:00');

    const read = await app.inject({
      method: 'GET',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
    });
    const body = read.json() as { schedules: { dayOfWeek: number; startTime: string }[] };
    expect(body.schedules).toHaveLength(3);
    expect(body.schedules[0]).toMatchObject({ dayOfWeek: 0, startTime: '00:00' });
  });

  it('il salvataggio sostituisce il programma precedente, non lo duplica', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const band = {
      dayOfWeek: 2,
      startTime: '07:00',
      endTime: '09:00',
      targetTemp: 21,
      preset: 'comfort',
    };

    await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: { schedules: [band] },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: { schedules: [{ ...band, targetTemp: 19 }] },
    });

    const schedules = (second.json() as { schedules: { targetTemp: number }[] }).schedules;
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.targetTemp).toBe(19);
  });

  it('rifiuta fasce sovrapposte e intervalli vuoti', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const overlap = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          { dayOfWeek: 1, startTime: '06:00', endTime: '09:00', targetTemp: 20, preset: 'comfort' },
          { dayOfWeek: 1, startTime: '08:00', endTime: '10:00', targetTemp: 21, preset: 'eco' },
        ],
      },
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json()).toMatchObject({ error: 'INVALID_BODY' });

    const empty = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '09:00', targetTemp: 20, preset: 'comfort' },
        ],
      },
    });
    expect(empty.statusCode).toBe(400);

    const outOfRange = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '10:00', targetTemp: 45, preset: 'comfort' },
        ],
      },
    });
    expect(outOfRange.statusCode).toBe(400);
  });

  it('il pannello kiosk programma le fasce e forza la temperatura', async () => {
    const { app } = await setup();
    const cookies = await kioskLogin(app);

    const save = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          { dayOfWeek: 2, startTime: '06:00', endTime: '08:00', targetTemp: 20, preset: 'comfort' },
        ],
      },
    });
    expect(save.statusCode).toBe(200);

    const override = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 21.5, durationMinutes: 60 },
    });
    expect(override.statusCode).toBe(201);
  });
});

describe('cronotermostato · override', () => {
  it('registra una forzatura a tempo con la scadenza esplicita', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 21.5, durationMinutes: 120, preset: 'comfort' },
    });

    expect(response.statusCode).toBe(201);
    const runtime = (response.json() as {
      runtime: { override: { targetTemp: number; until: number; permanent: boolean } };
    }).runtime;
    expect(runtime.override.targetTemp).toBe(21.5);
    expect(runtime.override.permanent).toBe(false);
    const minutes = (runtime.override.until - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(118);
    expect(minutes).toBeLessThanOrEqual(120);
  });

  it('"fino al prossimo cambio orario" usa l’inizio della fascia successiva', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const next = tomorrowAt(6);

    await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          {
            dayOfWeek: next.dayOfWeek,
            startTime: next.startTime,
            endTime: '08:00',
            targetTemp: 20,
            preset: 'comfort',
          },
        ],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 22, until: 'next_schedule' },
    });

    expect(response.statusCode).toBe(201);
    const override = (response.json() as {
      runtime: { override: { until: number | null } };
    }).runtime.override;
    expect(override.until).not.toBeNull();
    const until = new Date(override.until as number);
    expect(until.getHours()).toBe(6);
    expect(until.getMinutes()).toBe(0);
    expect(until.getTime()).toBeGreaterThan(Date.now());
  });

  it('senza fasce future l’override diventa permanente', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 20.5, until: 'next_schedule' },
    });

    expect(response.statusCode).toBe(201);
    expect(
      (response.json() as { runtime: { override: { permanent: boolean } } }).runtime.override
        .permanent,
    ).toBe(true);
  });

  it('annulla l’override e riprende il programma', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 23, durationMinutes: 240 },
    });

    const clear = await app.inject({
      method: 'DELETE',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
    });

    expect(clear.statusCode).toBe(200);
    expect(
      (clear.json() as { runtime: { override: unknown } }).runtime.override,
    ).toBeNull();

    const read = await app.inject({
      method: 'GET',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
    });
    expect((read.json() as { runtime: { override: unknown } }).runtime.override).toBeNull();
  });

  it('rifiuta scadenze nel passato e temperature fuori scala', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const past = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 20, until: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(past.statusCode).toBe(400);

    const cold = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 2, durationMinutes: 60 },
    });
    expect(cold.statusCode).toBe(400);
  });
});

describe('cronotermostato · job periodico sul database reale', () => {
  it('pubblica la fascia corrente una sola volta e memorizza l’ultimo setpoint', async () => {
    const { app, db } = await setup();
    const cookies = await login(app);
    const today = new Date().getDay();

    const save = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          {
            dayOfWeek: today,
            startTime: '00:00',
            endTime: '24:00',
            targetTemp: 20.5,
            preset: 'comfort',
          },
        ],
      },
    });
    expect(save.statusCode).toBe(200);

    const published: { topic: string; payload: string }[] = [];
    const scheduler = createClimateScheduler({
      db,
      publisher: {
        publish(topic, payload) {
          published.push({ topic, payload });
          return true;
        },
        close: async () => undefined,
      },
    });

    const first = await scheduler.tick(new Date());

    expect(first.published).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.topic).toBe('zigbee2mqtt/living/thermostat/set');
    expect(JSON.parse(published[0]?.payload ?? '{}')).toEqual({
      system_mode: 'heat',
      occupied_heating_setpoint: 20.5,
    });

    const runtime = await db.getClimateRuntime(DEVICE);
    expect(Number(runtime.last_sent_target_temp)).toBe(20.5);
    expect(runtime.last_sent_hvac_mode).toBe('comfort');

    // Secondo giro: stesso setpoint, nessun comando sul broker.
    const second = await scheduler.tick(new Date());
    expect(second.published).toBe(0);
    expect(published).toHaveLength(1);
  });

  it('con un override attivo il job non ripubblica il programma', async () => {
    const { app, db } = await setup();
    const cookies = await login(app);
    const today = new Date().getDay();

    await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/schedules`,
      cookies,
      payload: {
        schedules: [
          {
            dayOfWeek: today,
            startTime: '00:00',
            endTime: '24:00',
            targetTemp: 20.5,
            preset: 'comfort',
          },
        ],
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/override`,
      cookies,
      payload: { targetTemp: 22.5, durationMinutes: 90 },
    });

    const published: string[] = [];
    const scheduler = createClimateScheduler({
      db,
      publisher: {
        publish(_topic, payload) {
          published.push(payload);
          return true;
        },
        close: async () => undefined,
      },
    });

    await scheduler.tick(new Date());

    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0] ?? '{}')).toEqual({
      system_mode: 'heat',
      occupied_heating_setpoint: 22.5,
    });
  });
});

describe('cronotermostato · vacanza', () => {
  it('attiva, espone lo stato e termina la vacanza', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const until = new Date(Date.now() + 3 * 86_400_000).toISOString();

    const activate = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/vacation`,
      cookies,
      payload: { until },
    });
    expect(activate.statusCode).toBe(201);
    const vacation = (activate.json() as {
      runtime: { vacation: { until: number; permanent: boolean } };
    }).runtime.vacation;
    expect(vacation.until).toBe(new Date(until).getTime());
    expect(vacation.permanent).toBe(false);

    const stop = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/vacation`,
      cookies,
      payload: { active: false },
    });
    expect(stop.statusCode).toBe(201);
    expect((stop.json() as { runtime: { vacation: unknown } }).runtime.vacation).toBeNull();
  });

  it('un rientro nel passato viene rifiutato', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/climate/${DEVICE}/vacation`,
      cookies,
      payload: { until: new Date(Date.now() - 86_400_000).toISOString() },
    });

    expect(response.statusCode).toBe(400);
  });
});
