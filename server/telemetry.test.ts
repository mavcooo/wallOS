import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import type { MqttLink } from './mqttClient.js';
import {
  createTelemetryWorker,
  normalizeTelemetryPayload,
  telemetrySubscriptionTopics,
  telemetryTopicKey,
} from './services/telemetryWorker.js';

const PASSWORD = 'admin-password-123';
const HOUR_MS = 3_600_000;

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

interface SetupResult {
  app: FastifyInstance;
  db: Database;
  config: ReturnType<typeof loadConfig>;
}

async function setup(): Promise<SetupResult> {
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

  const { app } = await buildApp({ config, db });
  openApps.push(app);
  return { app, db, config };
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

interface HistoryPointDto {
  timestamp: number;
  value: number;
  min: number | null;
  max: number | null;
  samples: number;
}

interface HistoryDto {
  range: string;
  deviceId: string;
  metric: string;
  bucket: string;
  points: HistoryPointDto[];
  pointCount: number;
}

interface SummaryDto {
  summary: { min: number | null; max: number | null; avg: number | null; total: number | null; count: number };
}

async function ingest(
  app: FastifyInstance,
  cookies: Record<string, string>,
  sample: { deviceId: string; metricType: string; val: number; recordedAt?: Date },
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/telemetry/ingest',
    cookies,
    payload: {
      deviceId: sample.deviceId,
      metricType: sample.metricType,
      val: sample.val,
      ...(sample.recordedAt ? { recordedAt: sample.recordedAt.toISOString() } : {}),
    },
  });
  expect(response.statusCode).toBe(201);
}

async function history(
  app: FastifyInstance,
  cookies: Record<string, string>,
  query: string,
): Promise<HistoryDto> {
  const response = await app.inject({ method: 'GET', url: `/api/telemetry/history?${query}`, cookies });
  expect(response.statusCode).toBe(200);
  return response.json<HistoryDto>();
}

function createFakeLink(): MqttLink & {
  emit(topic: string, payload: string): void;
  subscribed: string[];
} {
  let handler: ((topic: string, payload: string) => void) | null = null;
  const subscribed: string[] = [];

  return {
    enabled: true,
    publish: () => true,
    subscribe(topic) {
      if (!subscribed.includes(topic)) subscribed.push(topic);
    },
    unsubscribe(topic) {
      const index = subscribed.indexOf(topic);
      if (index >= 0) subscribed.splice(index, 1);
    },
    onMessage(next) {
      handler = next;
    },
    close: () => Promise.resolve(),
    emit(topic, payload) {
      handler?.(topic, payload);
    },
    subscribed,
  };
}

describe('telemetria storica · endpoint', () => {
  it('richiede una sessione', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-oven&range=24h&metric=power_watts',
    });
    expect(response.statusCode).toBe(401);
  });

  it('accetta gli slug di `devices.id` e aggrega la finestra 24h in bucket da 30 minuti', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    // Base allineata all'ora: i bucket non dipendono dal minuto in cui gira il test.
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const samples: { val: number; recordedAt: Date }[] = [
      { val: 100, recordedAt: new Date(hour - 2 * HOUR_MS + 5 * 60_000) },
      { val: 300, recordedAt: new Date(hour - 2 * HOUR_MS + 10 * 60_000) },
      { val: 200, recordedAt: new Date(hour - 2 * HOUR_MS + 35 * 60_000) },
      { val: 500, recordedAt: new Date(hour - HOUR_MS + 45 * 60_000) },
    ];
    for (const sample of samples) {
      await ingest(app, cookies, { deviceId: 'power-kitchen-oven', metricType: 'power_watts', ...sample });
    }

    const body = await history(
      app,
      cookies,
      'deviceId=power-kitchen-oven&range=24h&metric=power_watts',
    );

    expect(body.bucket).toBe('30m');
    expect(body.pointCount).toBe(3);
    // Ordinati cronologicamente e allineati al bucket di 30 minuti.
    expect(body.points.map((point) => point.timestamp)).toEqual([
      hour - 2 * HOUR_MS,
      hour - 2 * HOUR_MS + 30 * 60_000,
      hour - HOUR_MS + 30 * 60_000,
    ]);
    expect(body.points[0]).toMatchObject({ value: 200, min: 100, max: 300, samples: 2 });
    expect(body.points[1]).toMatchObject({ value: 200, min: 200, max: 200, samples: 1 });
    expect(body.points[2]).toMatchObject({ value: 500, samples: 1 });
  });

  it('cambia bucket con l’intervallo: orario a 7 giorni, giornaliero a 30', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

    for (const offset of [1, 2, 3]) {
      await ingest(app, cookies, {
        deviceId: 'power-study-desk',
        metricType: 'power_watts',
        val: 50 * offset,
        recordedAt: new Date(hour - offset * HOUR_MS),
      });
    }

    const week = await history(app, cookies, 'deviceId=power-study-desk&range=7d&metric=power_watts');
    expect(week.bucket).toBe('1h');
    expect(week.pointCount).toBe(3);
    expect(week.points.every((point) => point.timestamp % HOUR_MS === 0)).toBe(true);

    const month = await history(app, cookies, 'deviceId=power-study-desk&range=30d&metric=power_watts');
    expect(month.bucket).toBe('1d');
    // I tre campioni orari collassano in un solo giorno (due se la mezzanotte
    // cade fra loro). Niente assunzioni sul fuso del database: `date_trunc`
    // lavora nel TimeZone della sessione PostgreSQL, non necessariamente UTC.
    expect(month.pointCount).toBeGreaterThanOrEqual(1);
    expect(month.pointCount).toBeLessThanOrEqual(2);
    expect(month.points.every((point) => point.timestamp % HOUR_MS === 0)).toBe(true);
  });

  it('senza deviceId somma i meter di tutta la casa, pesando ogni device allo stesso modo', async () => {
    const { app } = await setup();
    const cookies = await login(app);
    // Stesso bucket di 30 minuti, indipendente dal minuto in cui gira il test.
    const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 5 * 60_000;

    // Il forno ha due letture nel bucket: conta la media per device (200), non
    // la somma grezza (400), altrimenti un meter più frequente dominerebbe.
    for (const val of [100, 300]) {
      await ingest(app, cookies, {
        deviceId: 'power-kitchen-oven',
        metricType: 'power_watts',
        val,
        recordedAt: new Date(bucket),
      });
    }
    await ingest(app, cookies, {
      deviceId: 'power-study-desk',
      metricType: 'power_watts',
      val: 60,
      recordedAt: new Date(bucket),
    });
    await ingest(app, cookies, {
      deviceId: 'power-study-desk',
      metricType: 'energy_kwh',
      val: 12.5,
      recordedAt: new Date(bucket),
    });

    const all = await history(app, cookies, 'range=24h&metric=power_watts');
    expect(all.deviceId).toBe('all');
    expect(all.pointCount).toBe(1);
    expect(all.points[0]).toMatchObject({ value: 260, min: 160, max: 360, samples: 3 });

    const summary = await app.inject({
      method: 'GET',
      url: '/api/telemetry/summary?range=24h&metric=power_watts',
      cookies,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json<SummaryDto>().summary).toMatchObject({
      min: 160,
      max: 360,
      avg: 260,
      count: 3,
    });
  });

  it('rifiuta metriche o intervalli non previsti senza toccare il database', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const badMetric = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-oven&range=24h&metric=foo',
      cookies,
    });
    expect(badMetric.statusCode).toBe(400);
    expect(badMetric.json()).toMatchObject({ error: 'INVALID_QUERY' });

    const badRange = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?range=1y&metric=power_watts',
      cookies,
    });
    expect(badRange.statusCode).toBe(400);
  });

  it('riepiloga picco, media e delta del contatore energia', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    for (const val of [10, 14.5]) {
      await ingest(app, cookies, { deviceId: 'power-bedroom-plug', metricType: 'energy_kwh', val });
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry/summary?deviceId=power-bedroom-plug&range=24h&metric=energy_kwh',
      cookies,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<SummaryDto>().summary).toEqual({
      min: 10,
      max: 14.5,
      avg: 12.25,
      total: 4.5,
      count: 2,
    });
  });

  it('risponde con una finestra vuota invece di un errore', async () => {
    const { app } = await setup();
    const cookies = await login(app);

    const body = await history(app, cookies, 'deviceId=power-kitchen-oven&range=30d&metric=power_watts');
    expect(body.points).toEqual([]);
    expect(body.pointCount).toBe(0);

    const summary = await app.inject({
      method: 'GET',
      url: '/api/telemetry/summary?deviceId=power-kitchen-oven&range=30d&metric=power_watts',
      cookies,
    });
    expect(summary.json<SummaryDto>().summary).toEqual({
      min: null,
      max: null,
      avg: null,
      total: null,
      count: 0,
    });
  });

  it('riserva l’ingest manuale agli admin e valida il payload', async () => {
    const { app } = await setup();
    const kiosk = await session(app, '/api/auth/kiosk-session', {
      deviceId: 'wall-panel-1',
      pin: '1234',
    });

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/telemetry/ingest',
      cookies: kiosk,
      payload: { deviceId: 'power-kitchen-oven', metricType: 'power_watts', val: 10 },
    });
    expect(forbidden.statusCode).toBe(403);

    const cookies = await login(app);
    const badMetric = await app.inject({
      method: 'POST',
      url: '/api/telemetry/ingest',
      cookies,
      payload: { deviceId: 'power-kitchen-oven', metricType: 'power', val: 10 },
    });
    expect(badMetric.statusCode).toBe(400);
    expect(badMetric.json()).toMatchObject({ error: 'INVALID_BODY' });

    const unknownDevice = await app.inject({
      method: 'POST',
      url: '/api/telemetry/ingest',
      cookies,
      payload: { deviceId: 'power-inesistente', metricType: 'power_watts', val: 10 },
    });
    expect(unknownDevice.statusCode).toBe(404);
    expect(unknownDevice.json()).toMatchObject({ error: 'DEVICE_NOT_FOUND' });
  });
});

describe('telemetria storica · normalizzazione payload', () => {
  it('riconosce i dialetti Shelly, Tasmota e JSON custom', () => {
    // Shelly Gen2: potenza in W, energia cumulativa in Wh.
    expect(
      normalizeTelemetryPayload(
        'shelly/kitchen/dishwasher/status/switch:0',
        JSON.stringify({ output: true, apower: 1180.44, aenergy: { total: 843_700 } }),
      ),
    ).toEqual({ powerWatts: 1180.44, energyKwh: 843.7 });

    // Tasmota `tele/<device>/SENSOR`.
    expect(
      normalizeTelemetryPayload(
        'tele/kitchen/oven/SENSOR',
        JSON.stringify({ Time: '2026-10-28T10:00:00', ENERGY: { Power: 2200, Total: 412.1 } }),
      ),
    ).toEqual({ powerWatts: 2200, energyKwh: 412.1 });

    // Simulatori e firmware generici.
    expect(
      normalizeTelemetryPayload('domus/test/meter', JSON.stringify({ powerWatts: 42.5, energyKwh: 1.5 })),
    ).toEqual({ powerWatts: 42.5, energyKwh: 1.5 });

    // `fieldMap` configurato in admin per una scheda custom.
    expect(
      normalizeTelemetryPayload('domus/outdoor/gate', JSON.stringify({ meter: { power: 2, kwh: 4.6 } }), {
        watts: 'meter.power',
        energyTotalKwh: 'meter.kwh',
      }),
    ).toEqual({ powerWatts: 2, energyKwh: 4.6 });
  });

  it('gestisce i payload in chiaro e scarta rumore senza lanciare', () => {
    expect(normalizeTelemetryPayload('shellies/cucina/relay/0/power', '12.5')).toEqual({
      powerWatts: 12.5,
    });
    // Gen1 `energy` è in Wh.
    expect(normalizeTelemetryPayload('shellies/cucina/relay/0/energy', '1234000')).toEqual({
      energyKwh: 1234,
    });
    expect(normalizeTelemetryPayload('stat/kitchen/oven/POWER', 'ON')).toEqual({});
    expect(normalizeTelemetryPayload('domus/test/meter', '{not json')).toEqual({});
    expect(normalizeTelemetryPayload('domus/test/meter', JSON.stringify({ apower: Number.NaN }))).toEqual(
      {},
    );
    expect(normalizeTelemetryPayload('domus/test/meter', '')).toEqual({});
  });

  it('mappa i topic dei firmware sulla chiave del device e sulle sottoscrizioni', () => {
    expect(telemetryTopicKey('stat/kitchen/oven/POWER')).toBe('kitchen/oven');
    expect(telemetryTopicKey('tele/kitchen/oven/SENSOR')).toBe('kitchen/oven');
    expect(telemetryTopicKey('shelly/study/desk/status/switch:0')).toBe('study/desk');
    expect(telemetryTopicKey('shellies/cucina/relay/0/power')).toBe('cucina');
    expect(telemetryTopicKey('domus/outdoor/gate')).toBe('domus/outdoor/gate');

    expect(telemetrySubscriptionTopics('stat/kitchen/oven/POWER')).toEqual([
      'stat/kitchen/oven/POWER',
      'stat/kitchen/oven/#',
      'tele/kitchen/oven/#',
    ]);
    expect(telemetrySubscriptionTopics('shelly/study/desk/status/switch:0')).toEqual([
      'shelly/study/desk/status/switch:0',
      'shelly/study/desk/#',
    ]);
  });
});

describe('telemetria storica · worker di ingestion', () => {
  it('scrive i campioni dei device noti, con throttling e senza rompersi sul rumore', async () => {
    const { db, config } = await setup();
    const link = createFakeLink();
    const worker = createTelemetryWorker({ db, config, link });

    try {
      await worker.start();

      // Le wildcard sono radicate su un device noto: senza non ci sarebbe FK.
      expect(link.subscribed).toContain('shelly/kitchen/dishwasher/status/switch:0');
      expect(link.subscribed).toContain('tele/kitchen/oven/#');

      link.emit(
        'shelly/kitchen/dishwasher/status/switch:0',
        JSON.stringify({ apower: 1180.4, aenergy: { total: 843_700 } }),
      );
      link.emit(
        'tele/kitchen/oven/SENSOR',
        JSON.stringify({ ENERGY: { Power: 2200, Total: 412.1 } }),
      );
      link.emit('domus/outdoor/gate', JSON.stringify({ meter: { power: 2, kwh: 4.6 } }));
      // Stato relè: nessuna metrica energetica.
      link.emit('stat/kitchen/oven/POWER', 'ON');
      // Device non censito: il campione non è attribuibile e va scartato.
      link.emit('shellies/cucina/relay/0/power', '42');
      // Payload malformato: il worker resta vivo.
      link.emit('domus/outdoor/gate', '{not json');

      await worker.flush();

      const first = await db.client.query<{ device_id: string; metric_type: string; val: string }>(
        'SELECT device_id, metric_type, val FROM telemetry_history ORDER BY id',
      );
      expect(first.rows).toHaveLength(6);
      expect(first.rows.map((row) => [row.device_id, row.metric_type, Number(row.val)])).toEqual([
        ['power-kitchen-dishwasher', 'power_watts', 1180.4],
        ['power-kitchen-dishwasher', 'energy_kwh', 843.7],
        ['power-kitchen-oven', 'power_watts', 2200],
        ['power-kitchen-oven', 'energy_kwh', 412.1],
        ['power-outdoor-gate', 'power_watts', 2],
        ['power-outdoor-gate', 'energy_kwh', 4.6],
      ]);

      // Secondo giro immediato: il throttling di default (60 s) scarta tutto.
      link.emit(
        'shelly/kitchen/dishwasher/status/switch:0',
        JSON.stringify({ apower: 999, aenergy: { total: 843_900 } }),
      );
      await worker.flush();

      const second = await db.client.query<{ count: string }>(
        'SELECT COUNT(*)::int AS count FROM telemetry_history',
      );
      expect(Number(second.rows[0]?.count)).toBe(6);
    } finally {
      await worker.stop();
    }
  });
});
