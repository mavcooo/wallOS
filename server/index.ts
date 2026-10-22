import { loadEnvFile } from 'node:process';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

try {
  // Node 24: carica `.env` senza dipendenze aggiuntive. Se il file manca si
  // usano le variabili già presenti nell'ambiente (systemd, Docker, Infisical).
  loadEnvFile();
} catch {
  // Nessun .env locale: va bene, l'ambiente fa fede.
}

const config = loadConfig();

if (config.nodeEnv !== 'production' && !process.env.ADMIN_PASSWORD) {
  console.warn(
    '[auth] ADMIN_PASSWORD non impostata: in sviluppo viene usata la credenziale demo. ' +
      'Imposta ADMIN_PASSWORD, ADMIN_PIN e JWT_SECRET prima di esporre il servizio.',
  );
}

const { app } = await buildApp({ config, logger: true });

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
    `auth pronta · http://${config.host}:${config.port} · db ${config.dbPath}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
