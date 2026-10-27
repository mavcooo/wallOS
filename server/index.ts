import { loadEnvFile } from 'node:process';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { bootstrapMigrations } from './migrate.js';
import { createClimateScheduler, createMqttClimatePublisher } from './services/climateScheduler.js';

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

// Esegui migrazioni DATABASE prima di avviare il server
// Se il database è aggiornato o le migrazioni terminano con successo, avviare il server HTTP;
// in caso di errore DDL bloccante, interrompere il bootstrap con log di errore strutturato (process.exit(1))
let migrationsResult;
try {
  migrationsResult = await bootstrapMigrations();
  if (!migrationsResult.success) {
    console.error(`[migrate] Bootstrap interrotto: fallimento migratorie\n${migrationsResult.error}`);
    process.exit(1);
  }
  console.log('[migrate] Migrazioni applicate con successo');
} catch (error) {
  console.error(`[migrate] Errore critico durante il bootstrap delle migrazioni: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let built: Awaited<ReturnType<typeof buildApp>>;
try {
  built = await buildApp({ config, logger: true });
  // Controllo esplicito di startup: query reale sul pool prima di ascoltare,
  // con log compatto che non espone la password contenuta nella URL.
  await built.db.ping();
} catch (error) {
  console.error(`[auth] avvio interrotto · ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const app = built.app;

// Cronotermostato: un job al minuto valuta la fascia attiva e pubblica i
// setpoint sul broker locale. Vive qui e non in `buildApp` perché nei test
// l'istanza Fastify deve restare senza timer attivi.
const climatePublisher = createMqttClimatePublisher(config, app.log);
const climateScheduler = createClimateScheduler({
  db: built.db,
  publisher: climatePublisher,
  log: app.log,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'arresto del servizio auth');
  climateScheduler.stop();
  await built.automations.stop();
  await climatePublisher.close();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `auth pronta · http://${config.host}:${config.port} · db ${config.databaseUrl}`,
  );
  climateScheduler.start();
  // Motore di automazioni: cache dal database, sottoscrizioni MQTT e tick al
  // minuto. Vive qui e non in `buildApp` perché nei test l'istanza Fastify deve
  // restare senza timer attivi e senza socket verso il broker.
  built.automations.start();
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
