import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `pg.Pool` finto: cattura le opzioni passate da `createPool` e permette di
 * emettere `error` come farebbe un client inattivo che perde la socket.
 * I test sul percorso reale usano PGlite altrove; qui serve solo la
 * configurazione e il comportamento del pool.
 */
const pg = vi.hoisted(() => {
  interface Listener {
    (...args: unknown[]): void;
  }

  const SERVER_INFO_ROW = {
    version: 'PostgreSQL 17.4 on x86_64-pc-linux-gnu',
    database: 'wallos',
    username: 'wallos_user',
  };

  class FakePool {
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Listener[]>();
    ended = false;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      pg.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    /** Configurabile dai test: simulano successo o perdita della socket. */
    connect = async (): Promise<{
      query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;
      release: () => void;
    }> => {
      const client = await this.connectImpl();
      return client;
    };

    connectImpl: () => Promise<{
      query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;
      release: () => void;
    }> = async () => ({
      query: async () => ({ rows: [SERVER_INFO_ROW], rowCount: 1 }),
      release: () => {},
    });

    async end(): Promise<void> {
      this.ended = true;
    }
  }

  const instances: FakePool[] = [];
  return { FakePool, instances, SERVER_INFO_ROW };
});

const SERVER_INFO_ROW = pg.SERVER_INFO_ROW;

vi.mock('pg', () => ({ Pool: pg.FakePool }));

const { checkDatabaseHealth, closePool, createPool, Database, POOL_DEFAULTS } = await import(
  './db.js'
);

type PoolLike = Parameters<typeof checkDatabaseHealth>[0];

function fakePool(): InstanceType<typeof pg.FakePool> {
  return new pg.FakePool({});
}

function config(overrides: Partial<Parameters<typeof createPool>[0]> = {}) {
  return {
    connectionString: 'postgres://wallos_user:secret@192.168.0.59:5432/wallos',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ssl: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await closePool();
  pg.instances.length = 0;
});

describe('pool PostgreSQL · parametri di resilienza', () => {
  it('configura timeout, keep-alive TCP e nome applicazione', () => {
    createPool(config());
    const factory = pg.instances.at(-1);

    expect(factory?.options).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: 'wallos-auth',
    });
  });

  it('i default di `Database` coincidono con POOL_DEFAULTS', async () => {
    const db = new Database({ connectionString: config().connectionString });
    const factory = pg.instances.at(-1);

    expect(factory?.options).toMatchObject({
      max: POOL_DEFAULTS.max,
      connectionTimeoutMillis: POOL_DEFAULTS.connectionTimeoutMillis,
      idleTimeoutMillis: POOL_DEFAULTS.idleTimeoutMillis,
      keepAlive: POOL_DEFAULTS.keepAlive,
      keepAliveInitialDelayMillis: POOL_DEFAULTS.keepAliveInitialDelayMillis,
    });
    await db.close();
  });
});

describe('pool PostgreSQL · errore su client inattivo', () => {
  it('logga l’errore del socket idle senza lanciare eccezioni', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    createPool(config());
    const factory = pg.instances.at(-1);

    expect(factory?.listeners.get('error')).toHaveLength(1);
    expect(() =>
      factory?.emit(
        'error',
        Object.assign(new Error('terminating connection due to administrator command'), {
          code: '57P01',
        }),
      ),
    ).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('57P01');
    expect(String(log.mock.calls[0]?.[0])).toContain('connessione inattiva persa');
    log.mockRestore();
  });
});

describe('checkDatabaseHealth', () => {
  it('risponde healthy con latenza e identità del server, rilasciando il client', async () => {
    const release = vi.fn();
    const pool = fakePool();
    pool.connectImpl = async () => ({
      query: async () => ({ rows: [SERVER_INFO_ROW], rowCount: 1 }),
      release,
    });

    const health = await checkDatabaseHealth(pool as unknown as PoolLike);

    expect(health).toMatchObject({
      healthy: true,
      server: { database: 'wallos', user: 'wallos_user' },
    });
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rilascia il client anche quando la query fallisce', async () => {
    const release = vi.fn();
    const pool = fakePool();
    pool.connectImpl = async () => ({
      query: async () => {
        throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      },
      release,
    });

    const health = await checkDatabaseHealth(pool as unknown as PoolLike);

    expect(health).toMatchObject({ healthy: false, error: '57P01' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('non lancia quando il DB è irraggiungibile: restituisce il codice', async () => {
    const pool = fakePool();
    pool.connectImpl = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 192.168.0.59:5432'), {
        code: 'ECONNREFUSED',
      });
    };

    await expect(checkDatabaseHealth(pool as unknown as PoolLike)).resolves.toMatchObject({
      healthy: false,
      error: 'ECONNREFUSED',
    });
  });

  it('funziona con un SqlClient iniettato (PGlite/adattatori)', async () => {
    const client = {
      async query<T>() {
        return { rows: [SERVER_INFO_ROW] as T[], rowCount: 1 };
      },
      async exec() {},
    };

    await expect(checkDatabaseHealth(client)).resolves.toMatchObject({
      healthy: true,
      server: { database: 'wallos' },
    });
  });

  it('senza pool inizializzato riporta unhealthy invece di lanciare', async () => {
    await expect(checkDatabaseHealth()).resolves.toEqual({
      healthy: false,
      latencyMs: 0,
      error: 'POOL_NOT_INITIALIZED',
    });
  });

  it('`Database.health()` propaga l’esito senza eccezioni anche con client rotto', async () => {
    const db = new Database({
      connectionString: 'postgres://unused',
      client: {
        query: async () => {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        },
        exec: async () => {},
      },
    });

    await expect(db.health()).resolves.toMatchObject({ healthy: false, error: 'ECONNRESET' });
  });
});
