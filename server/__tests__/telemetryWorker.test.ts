import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { Database } from '../db.js';
import type { MqttLink } from '../mqttClient.js';
import {
  createTelemetryWorker,
  type TelemetryStats,
  type TelemetryStatsStore,
  type TelemetryWorker,
} from '../services/telemetryWorker.js';

const PASSWORD = 'admin-password-123';
const MINUTE_MS = 60_000;

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];
const openWorkers: TelemetryWorker[] = [];

afterEach(async () => {
  await Promise.all(openWorkers.splice(0).map((worker) => worker.stop()));
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

interface SetupResult {
  app: FastifyInstance;
  db: Database;
  engine: PGlite;
  config: ReturnType<typeof loadConfig>;
  telemetryStats: TelemetryStatsStore;
}

/** PGlite sul client iniettato; `beforeQuery` permette di simulare un DB giù. */
function createDatabase(
  config: ReturnType<typeof loadConfig>,
  engine: PGlite,
  beforeQuery?: (sql: string) => void,
): Database {
  return new Database({
    connectionString: config.databaseUrl,
    client: {
      async query<T>(sql: string, params?: readonly unknown[]) {
        beforeQuery?.(sql);
        const result = await engine.query<T>(sql, params ? [...params] : undefined);
        return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
      },
      async exec(sql: string) {
        await engine.exec(sql);
      },
    },
  });
}

async function setup(
  beforeQuery?: (sql: string) => void,
): Promise<SetupResult> {
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
  const db = createDatabase(config, engine, beforeQuery);

  const built = await buildApp({ config, db });
  openApps.push(built.app);
  return {
    app: built.app,
    db,
    engine,
    config,
    telemetryStats: built.telemetryStats,
  };
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

function track(worker: TelemetryWorker): TelemetryWorker {
  openWorkers.push(worker);
  return worker;
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

interface HistoryDto {
  deviceId: string;
  points: { timestamp: number; value: number; samples: number }[];
  pointCount: number;
}

interface StoredRow {
  val: string | number;
  recorded_at: Date | string;
}

async function storedRows(db: Database, deviceId: string, metricType: string): Promise<StoredRow[]> {
  const result = await db.client.query<StoredRow>(
    `SELECT val, recorded_at FROM telemetry_history
     WHERE device_id = $1 AND metric_type = $2
     ORDER BY recorded_at ASC, id ASC`,
    [deviceId, metricType],
  );
  return result.rows;
}

/** Attende che il worker abbia scritto, senza dipendere dal flush manuale. */
async function waitForIngested(worker: TelemetryWorker, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (worker.stats().totalIngested < expected) {
    if (Date.now() > deadline) {
      throw new Error(
        `timeout: attesi ${expected} campioni, scritti ${worker.stats().totalIngested}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('telemetria · worker di ingestion', () => {
  it('persiste un payload MQTT e lo rende leggibile da /api/telemetry/history', async () => {
    const { app, db, config, telemetryStats } = await setup();
    const link = createFakeLink();
    const worker = track(
      createTelemetryWorker({
        db,
        config,
        link,
        stats: telemetryStats,
        flushIntervalMs: 500,
        retentionIntervalMs: 60 * MINUTE_MS,
      }),
    );

    await worker.start();
    // Il device del seed è un meter Shelly Gen2: la wildcard nasce dal topic
    // di stato reale, non da un `+/...` che non avrebbe una FK valida.
    expect(link.subscribed).toContain('shelly/kitchen/dishwasher/status/switch:0');

    link.emit(
      'shelly/kitchen/dishwasher/status/switch:0',
      JSON.stringify({ apower: 1180.44, aenergy: { total: 843_700 } }),
    );

    // Nessuna chiamata manuale a `flush()`: il timer del worker scrive da sé.
    await waitForIngested(worker, 2);

    const cookies = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry/history?deviceId=power-kitchen-dishwasher&range=24h&metric=power_watts',
      cookies,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<HistoryDto>();
    expect(body.deviceId).toBe('power-kitchen-dishwasher');
    expect(body.pointCount).toBe(1);
    expect(body.points[0]).toMatchObject({ value: 1180.44, samples: 1 });

    const statsResponse = await app.inject({
      method: 'GET',
      url: '/api/telemetry/stats',
      cookies,
    });
    expect(statsResponse.statusCode).toBe(200);
    const stats = statsResponse.json<TelemetryStats>();
    expect(stats).toMatchObject({ started: true, totalIngested: 2, failedBatches: 0 });
    expect(stats.lastIngestAt).not.toBeNull();
  });

  it('richiede una sessione per le metriche del worker', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/telemetry/stats' });
    expect(response.statusCode).toBe(401);
  });

  it('scarta i campioni sotto la soglia delta e salva comunque l’heartbeat', async () => {
    const { db, config } = await setup();
    const link = createFakeLink();
    // Orologio controllato: delta, throttling e heartbeat senza attese reali.
    let now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const worker = track(
      createTelemetryWorker({
        db,
        config,
        link,
        sampleIntervalMs: 10_000,
        significantDeltaRatio: 0.02,
        heartbeatMs: 15 * MINUTE_MS,
        flushIntervalMs: 60 * MINUTE_MS,
        retentionIntervalMs: 60 * MINUTE_MS,
        now: () => now,
      }),
    );
    await worker.start();

    const topic = 'shelly/study/desk/status/switch:0';
    const emitPower = (powerWatts: number) =>
      link.emit(topic, JSON.stringify({ apower: powerWatts }));
    const tick = () => {
      now += 11_000;
    };

    emitPower(100);
    await worker.flush();

    // 101 W = +1%: sotto la soglia del 2%, nessuna riga.
    tick();
    emitPower(101);
    expect(worker.stats()).toMatchObject({ totalIngested: 1, totalSkipped: 1 });
    await worker.flush();

    // 103 W = +3% rispetto al 100 persistito: campione significativo.
    tick();
    emitPower(103);
    await worker.flush();
    expect(worker.stats()).toMatchObject({ totalIngested: 2, totalSkipped: 1 });

    // Serie piatta: il heartbeat forza il salvataggio anche senza variazione.
    now += 16 * MINUTE_MS;
    emitPower(103);
    await worker.flush();

    const powerRows = await storedRows(db, 'power-study-desk', 'power_watts');
    expect(powerRows.map((row) => Number(row.val))).toEqual([100, 103, 103]);
    expect(worker.stats()).toMatchObject({ totalIngested: 3, totalSkipped: 1 });

    // `energy_kwh` è cumulativo: il delta relativo non si applica, altrimenti
    // un incremento reale di 0,01 kWh verrebbe scartato per sempre.
    const energyTopic = 'shelly/study/desk/status/switch:0';
    link.emit(energyTopic, JSON.stringify({ aenergy: { total: 5_000 } }));
    tick();
    link.emit(energyTopic, JSON.stringify({ aenergy: { total: 5_010 } }));
    await worker.flush();

    const energyRows = await storedRows(db, 'power-study-desk', 'energy_kwh');
    expect(energyRows.map((row) => Number(row.val))).toEqual([5, 5.01]);
    expect(worker.stats().totalSkipped).toBe(1);
  });

  it('ritenta il batch fallito senza perdere i campioni', async () => {
    let failNextInsert = true;
    const { db, config } = await setup((sql) => {
      if (failNextInsert && /^\s*INSERT INTO telemetry_history/i.test(sql)) {
        failNextInsert = false;
        throw new Error('connessione al database persa');
      }
    });
    const link = createFakeLink();
    const worker = track(
      createTelemetryWorker({
        db,
        config,
        link,
        flushIntervalMs: 60 * MINUTE_MS,
        retentionIntervalMs: 60 * MINUTE_MS,
      }),
    );
    await worker.start();

    link.emit('shelly/kitchen/dishwasher/status/switch:0', JSON.stringify({ apower: 900 }));
    await worker.flush();

    expect(worker.stats()).toMatchObject({ totalIngested: 0, failedBatches: 1 });
    expect(await storedRows(db, 'power-kitchen-dishwasher', 'power_watts')).toHaveLength(0);

    // Il batch è tornato in coda: il flush successivo lo scrive.
    await worker.flush();
    expect(worker.stats()).toMatchObject({ totalIngested: 1, failedBatches: 1 });
    const rows = await storedRows(db, 'power-kitchen-dishwasher', 'power_watts');
    expect(rows.map((row) => Number(row.val))).toEqual([900]);
  });

  it('cancella i campioni oltre la retention e aggiorna le metriche', async () => {
    const { db, config } = await setup();
    const worker = track(
      createTelemetryWorker({
        db,
        config,
        link: createFakeLink(),
        retentionDays: 30,
        flushIntervalMs: 60 * MINUTE_MS,
        retentionIntervalMs: 60 * MINUTE_MS,
      }),
    );

    // Un campione vecchio di 31 giorni, uno di 29: la soglia è 30.
    await db.client.query(
      `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
       VALUES ('power-kitchen-oven', 'power_watts', 42, NOW() - INTERVAL '31 days'),
              ('power-kitchen-oven', 'power_watts', 43, NOW() - INTERVAL '29 days')`,
    );

    const deleted = await worker.runRetention();
    expect(deleted).toBe(1);

    const rows = await storedRows(db, 'power-kitchen-oven', 'power_watts');
    expect(rows.map((row) => Number(row.val))).toEqual([43]);
    expect(worker.stats().lastRetentionAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(worker.stats().lastRetentionAt ?? ''))).toBe(false);
  });

  it('ferma i timer, svuota la coda e chiude le sottoscrizioni allo stop', async () => {
    const { db, config } = await setup();
    const link = createFakeLink();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const worker = createTelemetryWorker({
      db,
      config,
      link,
      flushIntervalMs: 60 * MINUTE_MS,
      retentionIntervalMs: 60 * MINUTE_MS,
    });

    try {
      await worker.start();
      expect(link.subscribed.length).toBeGreaterThan(0);

      link.emit('shelly/kitchen/dishwasher/status/switch:0', JSON.stringify({ apower: 750 }));
      // Nessun flush manuale: deve farlo `stop()` prima di chiudere.
      await worker.stop();

      expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(link.subscribed).toEqual([]);
      expect(worker.stats().started).toBe(false);

      const rows = await storedRows(db, 'power-kitchen-dishwasher', 'power_watts');
      expect(rows.map((row) => Number(row.val))).toEqual([750]);
    } finally {
      clearSpy.mockRestore();
      await worker.stop();
    }
  });
});
