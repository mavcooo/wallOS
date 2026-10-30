import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DDL_LOCK_TIMEOUT_MS,
  DEFAULT_DDL_STATEMENT_TIMEOUT_MS,
  migrateDown,
  migrateUp,
  MigrationError,
  type MigrationConnection,
} from '../migrate.js';

/**
 * Resilienza dell'infrastruttura database, ai due confini che tengono in piedi
 * il backend:
 *
 * 1. **pool `pg`** — un client idle interrotto (riavvio di PostgreSQL, cavo
 *    sfilato, sessione NAT scartata) non deve terminare il processo Node né
 *    lasciare il pool inutilizzabile;
 * 2. **migrazioni** — `lock_timeout` e `statement_timeout` devono essere
 *    attivi dentro la transazione DDL, così un lock conteso fa fallire il
 *    bootstrap con un errore chiaro invece di appenderlo per sempre.
 *
 * `pg.Pool` è finto (cattura le opzioni di `createPool` ed emette `error` come
 * il driver vero); la policy DDL è verificata su PostgreSQL reale (PGlite),
 * mentre la contesa fra due sessioni — che una sola connessione non può
 * rappresentare — è riprodotta con una sessione finta che restituisce il
 * codice che PostgreSQL userebbe (`55P03`/`57014`).
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

    /** Query dirette sul pool (`createSqlClient`): è quella di `Database.ping()`. */
    async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
      if (sql.includes('SELECT 1 AS ok')) return { rows: [{ ok: 1 }], rowCount: 1 };
      return { rows: [SERVER_INFO_ROW], rowCount: 1 };
    }

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
  '../db.js'
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

const noop = (): void => {};
const openEngines: PGlite[] = [];
const tempDirs: string[] = [];

beforeEach(async () => {
  await closePool();
  pg.instances.length = 0;
});

afterEach(async () => {
  await Promise.all(openEngines.splice(0).map((engine) => engine.close()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Cartella con i file di migrazione del caso in esame. */
function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallos-ddl-policy-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

/** File con i marcatori macchina che il runner sa tagliare. */
function migrationFile(file: string, up: string, down?: string): string {
  const downSection = down ? `-- ${file} - DOWN\n${down}\n` : '';
  return `-- ${file} - UP\n${up}\n${downSection}`;
}

/**
 * `DO` che fallisce se la policy DDL non è attiva **dentro** la transazione.
 *
 * È l'asserzione che conta davvero: se il runner smettesse di emettere
 * `SET LOCAL`, PostgreSQL riporterebbe i valori di sessione (`0`) e questa
 * migrazione abortirebbe invece di passare inosservata.
 */
function policyAssertion(expected: { lockMs: number; statementMs: number }): string {
  return `DO $$
DECLARE
  lock_ms numeric := extract(epoch from current_setting('lock_timeout')::interval) * 1000;
  statement_ms numeric := extract(epoch from current_setting('statement_timeout')::interval) * 1000;
BEGIN
  IF lock_ms <> ${expected.lockMs} THEN
    RAISE EXCEPTION 'lock_timeout atteso ${expected.lockMs} ms, trovato % ms', lock_ms;
  END IF;
  IF statement_ms <> ${expected.statementMs} THEN
    RAISE EXCEPTION 'statement_timeout atteso ${expected.statementMs} ms, trovato % ms', statement_ms;
  END IF;
END $$;`;
}

/** PostgreSQL vero (PGlite) che registra gli statement: serve per l'ordine. */
function pgliteConnection(): { engine: PGlite; connection: MigrationConnection; statements: string[] } {
  const engine = new PGlite();
  openEngines.push(engine);
  const statements: string[] = [];

  const connection: MigrationConnection = {
    async query<T>(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      const result = await engine.query<T>(sql, params ? [...params] : undefined);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      statements.push(sql);
      await engine.exec(sql);
    },
  };

  return { engine, connection, statements };
}

/**
 * Sessione finta con ledger e advisory lock in memoria, dove un DDL può fallire
 * con il codice che PostgreSQL usa quando `lock_timeout`/`statement_timeout`
 * scattano. PGlite ha una sola sessione: una contesa **reale** fra due
 * transazioni non è rappresentabile, quindi qui si riproduce l'errore che il
 * server restituirebbe (`55P03` / `57014`) e si osserva come reagisce il
 * runner: errore tipizzato, ROLLBACK, ledger intatto, retry possibile.
 */
function createGuardedConnection(
  guard: (sql: string) => Error | null,
): { connection: MigrationConnection; statements: string[]; ledger: string[] } {
  const statements: string[] = [];
  const ledger: string[] = [];

  const connection: MigrationConnection = {
    async query<T>(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: true } as T] };
      }
      if (sql.startsWith('SELECT version FROM schema_migrations')) {
        const versions = sql.includes('ORDER BY id DESC') ? [...ledger].reverse() : [...ledger];
        return { rows: versions.map((version) => ({ version }) as T) };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        ledger.push(String(params?.[0]));
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM schema_migrations')) {
        const index = ledger.indexOf(String(params?.[0]));
        if (index >= 0) ledger.splice(index, 1);
        return { rows: [] };
      }
      return { rows: [] as T[] };
    },
    async exec(sql: string) {
      statements.push(sql);
      const body = sql.trim();
      if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return;
      if (body.startsWith('SET LOCAL ')) return;
      if (body.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return;
      const failure = guard(body);
      if (failure) throw failure;
    },
  };

  return { connection, statements, ledger };
}

/** Errore nella forma che produce il driver `pg` per un timeout del server. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

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

describe('pool PostgreSQL · sopravvivenza al drop di un client idle', () => {
  it('dopo l’errore il processo resta attivo e la query successiva funziona', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new Database({ connectionString: config().connectionString });
    const factory = pg.instances.at(-1);

    // Stessa istanza di pool che usa l'app: il socket idle muore (riavvio del
    // server PostgreSQL, cavo sfilato, sessione NAT scartata).
    expect(factory?.listeners.get('error')).toHaveLength(1);
    expect(() =>
      factory?.emit(
        'error',
        pgError('57P01', 'terminating connection due to administrator command'),
      ),
    ).not.toThrow();

    // Nessuna eccezione non gestita: il pool è ancora utilizzabile.
    await expect(db.ping()).resolves.toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(factory?.ended).toBe(false);

    await db.close();
    log.mockRestore();
  });
});

describe('migrazioni · policy DDL (lock_timeout / statement_timeout)', () => {
  it('applica i valori di default dentro la transazione di migrazione', async () => {
    const file = '001_ddl_policy.sql';
    const dir = makeTempDir({
      [file]: migrationFile(
        file,
        `${policyAssertion({
          lockMs: DEFAULT_DDL_LOCK_TIMEOUT_MS,
          statementMs: DEFAULT_DDL_STATEMENT_TIMEOUT_MS,
        })}\nCREATE TABLE ddl_policy_probe (id int);`,
      ),
    });
    const { connection, engine } = pgliteConnection();

    const result = await migrateUp({ connection, dir, log: noop });

    expect(result.applied).toEqual([file]);
    const probe = await engine.query<{ name: string | null }>(
      "SELECT to_regclass('public.ddl_policy_probe')::text AS name",
    );
    expect(probe.rows[0]?.name).toBe('ddl_policy_probe');
    const ledger = await engine.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY id',
    );
    expect(ledger.rows.map((row) => row.version)).toEqual([file]);
  });

  it('i timeout sono configurabili e valgono anche per il rollback', async () => {
    const file = '001_ddl_custom.sql';
    const expected = { lockMs: 1_500, statementMs: 2_500 };
    const dir = makeTempDir({
      [file]: migrationFile(
        file,
        `${policyAssertion(expected)}\nCREATE TABLE ddl_custom_probe (id int);`,
        `${policyAssertion(expected)}\nDROP TABLE ddl_custom_probe;`,
      ),
    });
    const { connection, engine } = pgliteConnection();
    const options = {
      connection,
      dir,
      log: noop,
      ddlLockTimeoutMs: expected.lockMs,
      ddlStatementTimeoutMs: expected.statementMs,
    };

    await expect(migrateUp(options)).resolves.toEqual({ applied: [file] });
    await expect(migrateDown(options)).resolves.toEqual({ rolledBack: file });

    const probe = await engine.query<{ name: string | null }>(
      "SELECT to_regclass('public.ddl_custom_probe')::text AS name",
    );
    expect(probe.rows[0]?.name).toBeNull();
  });

  it('emette SET LOCAL subito dopo BEGIN, prima di ogni DDL', async () => {
    const file = '001_ordine.sql';
    const dir = makeTempDir({
      [file]: migrationFile(file, 'CREATE TABLE order_probe (id int);'),
    });
    const { connection, statements } = pgliteConnection();

    await migrateUp({ connection, dir, log: noop, ddlLockTimeoutMs: 1_200 });

    const lock = statements.indexOf("SET LOCAL lock_timeout = '1200ms'");
    const statement = statements.indexOf("SET LOCAL statement_timeout = '30000ms'");
    const body = statements.findIndex((sql) => sql.includes('CREATE TABLE order_probe'));

    expect(statements[0]).toBe('BEGIN');
    expect(lock).toBe(1);
    expect(statement).toBe(2);
    expect(body).toBeGreaterThan(statement);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('un valore non valido non disattiva la protezione: torna al default', async () => {
    const file = '001_fallback.sql';
    const dir = makeTempDir({
      [file]: migrationFile(file, 'CREATE TABLE fallback_probe (id int);'),
    });
    const { connection, statements } = pgliteConnection();

    await migrateUp({
      connection,
      dir,
      log: noop,
      ddlLockTimeoutMs: 0,
      ddlStatementTimeoutMs: Number.NaN,
    });

    expect(statements).toContain(`SET LOCAL lock_timeout = '${DEFAULT_DDL_LOCK_TIMEOUT_MS}ms'`);
    expect(statements).toContain(
      `SET LOCAL statement_timeout = '${DEFAULT_DDL_STATEMENT_TIMEOUT_MS}ms'`,
    );
  });

  it('un lock conteso (55P03) fa fallire il bootstrap con ROLLBACK, non lo appende', async () => {
    const file = '001_lock_conteso.sql';
    const dir = makeTempDir({
      [file]: migrationFile(file, 'ALTER TABLE devices ADD COLUMN nickname text;'),
    });
    let heldByOtherSession = true;
    const session = createGuardedConnection((sql) =>
      heldByOtherSession && sql.includes('ALTER TABLE devices')
        ? pgError('55P03', 'canceling statement due to lock timeout')
        : null,
    );

    const error = await migrateUp({ connection: session.connection, dir, log: noop }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).code).toBe('SQL_ERROR');
    expect((error as MigrationError).message).toContain(file);
    expect((error as MigrationError).message).toContain('lock timeout');
    expect((error as MigrationError).message).toContain(
      `lock_timeout ${DEFAULT_DDL_LOCK_TIMEOUT_MS} ms`,
    );
    // Transazione abortita per intero: nessun ledger, nessun DDL applicato.
    expect(session.statements).toContain('ROLLBACK');
    expect(session.statements.some((sql) => sql.includes('INSERT INTO schema_migrations'))).toBe(
      false,
    );
    expect(session.ledger).toEqual([]);

    // Rilasciato il lock, lo stesso ciclo riparte: il bootstrap non resta rotto.
    heldByOtherSession = false;
    await expect(migrateUp({ connection: session.connection, dir, log: noop })).resolves.toEqual({
      applied: [file],
    });
    expect(session.ledger).toEqual([file]);
    expect(session.statements.at(-1)).toBe('COMMIT');
  });

  it('una statement oltre lo statement_timeout (57014) riporta il limite nel messaggio', async () => {
    const file = '001_statement_lento.sql';
    const dir = makeTempDir({
      [file]: migrationFile(file, 'CREATE INDEX CONCURRENTLY lento ON devices (name);'),
    });
    const session = createGuardedConnection((sql) =>
      sql.includes('CREATE INDEX CONCURRENTLY')
        ? pgError('57014', 'canceling statement due to statement timeout')
        : null,
    );

    const error = await migrateUp({
      connection: session.connection,
      dir,
      log: noop,
      ddlStatementTimeoutMs: 750,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).code).toBe('SQL_ERROR');
    expect((error as MigrationError).message).toContain('statement timeout');
    expect((error as MigrationError).message).toContain('statement_timeout 750 ms');
    expect(session.statements).toContain('ROLLBACK');
    expect(session.ledger).toEqual([]);
  });
});
