import { loadEnvFile } from 'node:process';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { checkDatabaseConnection, describeDatabaseError, describeDatabaseTarget } from './db.js';

try {
  // Node 24: carica `.env` senza dipendenze aggiuntive. Se il file manca si
  // usano le variabili già presenti nell'ambiente (systemd, Docker, Infisical).
  loadEnvFile();
} catch {
  // Nessun .env locale: va bene, l'ambiente fa fede.
}

let config: ReturnType<typeof loadConfig>;
try {
  // Errore bloccante e descrittivo: elenca tutte le variabili mancanti o malformate.
  config = loadConfig();
} catch (error) {
  console.error(`[auth] configurazione non valida\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (config.nodeEnv !== 'production' && !process.env.ADMIN_PASSWORD) {
  console.warn(
    '[auth] ADMIN_PASSWORD non impostata: in sviluppo viene usata la credenziale demo. ' +
      'Imposta ADMIN_PASSWORD, ADMIN_PIN e JWT_SECRET prima di esporre il servizio.',
  );
}

const databaseTarget = describeDatabaseTarget(config.databaseUrl);

let app;
try {
  const built = await buildApp({ config, logger: true });
  app = built.app;
  // Controllo esplicito di startup: query reale sul pool prima di ascoltare,
  // con log compatto che non espone la password contenuta nella URL.
  await checkDatabaseConnection(built.db.client, {
    connectionString: config.databaseUrl,
    source: config.databaseUrlSource,
    log: (message) => built.app.log.info(message),
  });
} catch (error) {
  console.error(`[auth] avvio interrotto · ${describeDatabaseError(error, config.databaseUrl)}`);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'arresto del servizio auth');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `auth pronta · http://${config.host}:${config.port} · db ${databaseTarget}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
