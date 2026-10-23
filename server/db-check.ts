import { loadEnvFile } from 'node:process';

import { loadConfig } from './config.js';
import {
  checkDatabaseConnection,
  Database,
  describeDatabaseError,
} from './db.js';

/**
 * Verifica la raggiungibilità del PostgreSQL configurato (default:
 * `192.168.0.59:5432/wallos`) senza applicare schema o seed: esegue solo la
 * query di identità del server. Stesse variabili del servizio, stesso `.env`.
 *
 *   npm run db:check
 *
 * Exit code 0 = connessione OK, 1 = configurazione o connessione fallita.
 */
try {
  // Node 24: stesso caricamento del bootstrap (`server/index.ts`).
  loadEnvFile();
} catch {
  // Nessun `.env` locale: valgono le variabili già presenti nell'ambiente.
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error(
    `[db] configurazione non valida\n${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

// Nessun `init()`: il check non tocca schema né dati applicativi.
const db = new Database({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  ssl: config.dbSsl,
  connectionTimeoutMillis: config.dbConnectTimeoutMs,
  idleTimeoutMillis: config.dbIdleTimeoutMs,
});

try {
  await checkDatabaseConnection(db.client, {
    connectionString: config.databaseUrl,
    source: config.databaseUrlSource,
    log: console.log,
  });
} catch (error) {
  console.error(`[db] verifica fallita · ${describeDatabaseError(error, config.databaseUrl)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
