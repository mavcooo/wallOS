import { loadEnvFile } from 'node:process';

import { Pool } from 'pg';

import { loadDatabaseConfig } from './config.js';
import {
  checkDatabaseHealth,
  createPool,
  describeDatabaseError,
  POOL_DEFAULTS,
  type DatabaseHealth,
} from './db.js';

/**
 * Simula la perdita di una connessione **inattiva** del pool senza riavviare
 * PostgreSQL: apre il pool con la stessa configurazione del servizio, lascia
 * un client idle, ne termina il backend dal lato server (`pg_terminate_backend`)
 * e verifica che:
 *
 *   1. l'errore arrivi come evento `error` sul pool (loggato, non lanciato);
 *   2. il processo resti vivo;
 *   3. la query successiva riapra una connessione e risponda.
 *
 *   npm run db:resilience
 *
 * Exit code 0 = pool resiliente, 1 = verifica fallita, 2 = test inconcludente
 * (permessi insufficienti per terminare il backend).
 */

try {
  // Node 24: stesso caricamento del bootstrap (`server/index.ts`).
  loadEnvFile();
} catch {
  // Nessun `.env` locale: valgono le variabili già presenti nell'ambiente.
}

let config: ReturnType<typeof loadDatabaseConfig>;
try {
  config = loadDatabaseConfig();
} catch (error) {
  console.error(
    `[db] configurazione non valida\n${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const target = `${config.host}:${config.port}/${config.name}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

function report(label: string, health: DatabaseHealth): void {
  if (health.healthy) {
    const version = health.server?.version.split(' ').slice(0, 2).join(' ') ?? 'sconosciuta';
    console.log(`[db] ${label} · healthy · ${version} · ${health.latencyMs ?? 0} ms`);
    return;
  }
  console.error(`[db] ${label} · unhealthy · ${health.error ?? 'errore sconosciuto'}`);
}

// Un solo client: il backend da terminare è esattamente quello del pool.
const pool = createPool({
  connectionString: config.url,
  max: 1,
  idleTimeoutMillis: config.idleTimeoutMs,
  connectionTimeoutMillis: config.connectTimeoutMs,
  keepAlive: POOL_DEFAULTS.keepAlive,
  keepAliveInitialDelayMillis: POOL_DEFAULTS.keepAliveInitialDelayMillis,
  ssl: config.ssl,
});

// `createPool` registra già il listener che logga: qui se ne aggiunge uno solo
// per contare gli eventi e verificare che il driver li abbia emessi.
const lostConnections: string[] = [];
pool.on('error', (error: Error) => {
  lostConnections.push(error.message);
});

let failure: string | null = null;
let inconclusive = false;

try {
  const before = await checkDatabaseHealth(pool);
  report('prima del drop', before);
  if (!before.healthy) {
    console.error(`[db] il database ${target} non risponde: impossibile simulare il drop`);
    process.exitCode = 1;
    throw new Error('database irraggiungibile');
  }

  // Client lasciato tornare idle nel pool: è quello che morirà.
  const client = await pool.connect();
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  client.release();
  if (!pid) throw new Error('pg_backend_pid() non ha restituito un pid');
  console.log(`[db] backend idle del pool: pid ${pid} (pool max 1)`);

  // Connessione separata (non del pool): termina il backend come farebbe un
  // riavvio di PostgreSQL o uno switch che scarta la sessione.
  const killer = new Pool({
    connectionString: config.url,
    max: 1,
    connectionTimeoutMillis: config.connectTimeoutMs,
    ...(config.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    application_name: 'wallos-resilience-check',
  });

  try {
    const killed = await killer.query<{ killed: boolean }>(
      'SELECT pg_terminate_backend($1) AS killed',
      [pid],
    );
    if (!killed.rows[0]?.killed) {
      inconclusive = true;
      console.error(
        `[db] pg_terminate_backend(${pid}) ha rifiutato: servono privilegi sul backend ` +
          `(superuser o stesso ruolo). Usa "sudo systemctl restart postgresql" per la prova reale.`,
      );
    } else {
      console.log(`[db] backend ${pid} terminato lato server`);
    }
  } finally {
    await killer.end();
  }

  // L'evento arriva quando il socket chiuso viene raccolto dal pool.
  const noticed = await waitFor(() => lostConnections.length > 0, 2_000);
  if (noticed) {
    console.log(`[db] evento 'error' sul pool intercettato (${lostConnections.length})`);
  } else if (!inconclusive) {
    failure = "il pool non ha emesso 'error' dopo la terminazione del backend";
  }

  // La query successiva deve riaprire una connessione: un eventuale errore
  // residuo viene ritentato una volta, come farebbe il chiamante.
  let after = await checkDatabaseHealth(pool);
  if (!after.healthy) {
    await sleep(200);
    after = await checkDatabaseHealth(pool);
  }
  report('dopo il drop', after);

  if (!after.healthy) {
    failure = `il pool non si è ripreso: ${after.error ?? 'errore sconosciuto'}`;
  }

  if (failure) {
    console.error(`[db] RESILIENZA FALLITA · ${failure}`);
    process.exitCode = 1;
  } else if (inconclusive) {
    console.error('[db] test inconcludente: il backend non è stato terminato');
    process.exitCode = 2;
  } else {
    console.log(
      `[db] OK · ${lostConnections.length} connessioni inattive perse, processo vivo, ` +
        `pool riconnesso in ${after.latencyMs ?? 0} ms`,
    );
    process.exitCode = 0;
  }
} catch (error) {
  if (process.exitCode === undefined) {
    console.error(`[db] verifica fallita · ${describeDatabaseError(error, config.url)}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
