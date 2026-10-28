import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { initialDevices } from './seed-data/devices.js';
import { SEED_FLOORS } from './seed-data/floors.js';
import { SEED_ROOMS } from './seed-data/rooms.js';
import { SCENARIOS } from './seed-data/scenarios.js';
import { countSeedRows, seedDatabase } from './seed.js';

const PASSWORD = 'admin-password-123';

const openApps: FastifyInstance[] = [];
const openEngines: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
});

/** Stesso setup degli altri test server: PostgreSQL reale (WASM) e schema vero. */
async function createDb(): Promise<{ db: Database; config: ReturnType<typeof loadConfig> }> {
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
  await db.init();
  return { db, config };
}

/** Log muto: i test verificano gli esiti, non l'output della CLI. */
const quiet = { log: () => {} };

describe('seed demo', () => {
  it('su database vergine inserisce piani, topologia, scenari e account', async () => {
    const { db, config } = await createDb();

    const result = await seedDatabase(db, config, quiet);

    expect(result).toMatchObject({ seeded: true, outcome: 'seeded' });
    expect(await countSeedRows(db)).toEqual({
      floors: SEED_FLOORS.length,
      rooms: SEED_ROOMS.length,
      devices: initialDevices.length,
      scenarios: SCENARIOS.length,
    });
    expect(await db.findUserByUsername(config.seed.adminUsername)).not.toBeNull();
    expect(await db.findKioskByDeviceId(config.seed.kioskDeviceId)).not.toBeNull();
  });

  it('su database già popolato non scrive nulla e non ripristina le modifiche utente', async () => {
    const { db, config } = await createDb();
    await seedDatabase(db, config, quiet);

    // Modifiche fatte dall'utente: una stanza rinominata e un device eliminato.
    await db.client.query("UPDATE rooms SET name = 'Salotto' WHERE id = 'living'");
    await db.client.query("DELETE FROM devices WHERE id = 'light-living-main'");

    const result = await seedDatabase(db, config, quiet);

    expect(result).toMatchObject({ seeded: false, outcome: 'skipped' });
    const room = await db.client.query<{ name: string }>(
      "SELECT name FROM rooms WHERE id = 'living'",
    );
    expect(room.rows[0]?.name).toBe('Salotto');
    const devices = await db.client.query<{ id: string }>(
      "SELECT id FROM devices WHERE id = 'light-living-main'",
    );
    expect(devices.rows).toHaveLength(0);
  });

  it('--force azzera le tabelle demo (CASCADE compreso) e le ricrea', async () => {
    const { db, config } = await createDb();
    await seedDatabase(db, config, quiet);
    await db.client.query("UPDATE rooms SET name = 'Salotto' WHERE id = 'living'");
    await db.client.query("DELETE FROM devices WHERE id = 'light-living-main'");
    await db.client.query(
      `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
       VALUES ('power-kitchen-oven', 'power_watts', 120, NOW())`,
    );

    const result = await seedDatabase(db, config, { force: true, log: () => {} });

    expect(result).toMatchObject({ seeded: true, outcome: 'forced' });
    const room = await db.client.query<{ name: string }>(
      "SELECT name FROM rooms WHERE id = 'living'",
    );
    expect(room.rows[0]?.name).toBe('Soggiorno');
    expect((await countSeedRows(db)).devices).toBe(initialDevices.length);
    // `TRUNCATE … CASCADE` porta via anche lo storico del device seed.
    const history = await db.client.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM telemetry_history',
    );
    expect(Number(history.rows[0]?.count)).toBe(0);
    // Gli account non vengono toccati: nessun duplicato, stesse credenziali.
    const admins = await db.client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM users WHERE username = $1",
      [config.seed.adminUsername],
    );
    expect(Number(admins.rows[0]?.count)).toBe(1);
  });

  it('il bootstrap non semina con AUTO_SEED spento (default)', async () => {
    const { db, config } = await createDb();
    expect(config.seed.autoSeed).toBe(false);

    const { app } = await buildApp({ config, db });
    openApps.push(app);

    expect(await countSeedRows(db)).toEqual({ floors: 0, rooms: 0, devices: 0, scenarios: 0 });
    expect(await db.findUserByUsername(config.seed.adminUsername)).toBeFalsy();
  });

  it('con AUTO_SEED=true il primo avvio popola il database', async () => {
    const { db } = await createDb();
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

    const { app } = await buildApp({ config, db });
    openApps.push(app);

    expect(await countSeedRows(db)).toMatchObject({
      floors: SEED_FLOORS.length,
      rooms: SEED_ROOMS.length,
      devices: initialDevices.length,
    });
    expect(await db.findUserByUsername(config.seed.adminUsername)).not.toBeNull();
  });
});
