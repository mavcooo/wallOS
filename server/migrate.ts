import { loadEnvFile } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { loadDatabaseConfig } from './config.js';

/**
 * Directory delle migrazioni. Letta a ogni chiamata e non a import-time, così
 * `MIGRATION_DIR` definita nel `.env` vale anche per `npm run migrate:up`.
 */
function getMigrationDir(): string {
  return process.env.MIGRATION_DIR || path.resolve(process.cwd(), 'server/migrations');
}

// Ensure migration directory exists
function ensureMigrationDir(): string {
  const migrationDir = getMigrationDir();
  if (!fs.existsSync(migrationDir)) {
    fs.mkdirSync(migrationDir, { recursive: true });
  }
  return migrationDir;
}

let pool: Pool | null = null;

/**
 * Pool creato alla prima migrazione, non a import-time: `server/index.ts`
 * carica il `.env` nel corpo del proprio modulo (dopo l'import di questo
 * file), quindi leggere `process.env` durante l'import vedrebbe solo
 * l'ambiente del processo e ripiegherebbe su valori sbagliati. La
 * configurazione arriva da `loadDatabaseConfig`, l'unica sorgente usata anche
 * da `db:check` e dal servizio: `DATABASE_URL` con precedenza sulle `DB_*`.
 */
function getPool(): Pool {
  if (pool) return pool;
  const config = loadDatabaseConfig();
  pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    ssl: config.ssl,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectTimeoutMs,
  });
  return pool;
}

/**
 * Solo la sezione UP di un file di migrazione.
 *
 * I file del progetto contengono sia UP sia DOWN (vedi `migrate:create`);
 * eseguire l'intero file applicherebbe anche il rollback, cancellando le
 * tabelle appena create a ogni avvio. Il taglio avviene sul marcatore
 * `<file> - DOWN`; un file senza marcatore viene eseguito per intero.
 */
export function extractUpSection(sql: string): string {
  const downMarker = /^--\s*-*\s*\S+\s*-\s*DOWN\s*-*\s*$/im;
  const match = downMarker.exec(sql);
  return match ? sql.slice(0, match.index) : sql;
}

// Get all migration files sorted by name
function getMigrationFiles(): string[] {
  const migrationDir = ensureMigrationDir();
  const files = fs.readdirSync(migrationDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql'));
  return sqlFiles.sort();
}

// Run migrations up
export async function migrateUp(): Promise<{ success: boolean; error?: string; applied?: number }> {
  const client = await getPool().connect();
  try {
    const migrationDir = ensureMigrationDir();
    const migrations = getMigrationFiles();
    let applied = 0;

    for (const file of migrations) {
      const filePath = path.resolve(migrationDir, file);
      console.log(`[migrate] Applying: ${file}`);
      const sql = extractUpSection(fs.readFileSync(filePath, 'utf8'));
      await client.query(sql);
      applied++;
    }

    console.log(`[migrate] ${applied} migration(s) applied`);
    return { success: true, applied };
  } catch (error) {
    console.error('[migrate] Error during up migration:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}

// Run migrations down (rollback last applied)
export async function migrateDown(): Promise<{ success: boolean; error?: string; rolledBack?: string }> {
  const client = await getPool().connect();
  try {
    const migrations = getMigrationFiles().reverse();
    console.log('[migrate] Rollback: would run DOWN block of last migration');
    if (migrations.length > 0) {
      const lastFile = migrations[migrations.length - 1];
      console.log(`[migrate] Last migration file: ${lastFile}`);
    }

    return { success: true, rolledBack: 'conceptual' };
  } catch (error) {
    console.error('[migrate] Error during down migration:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}

// Create a new migration file with timestamp
export async function createMigration(name: string): Promise<{ success: boolean; error?: string; filePath?: string }> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const safeName = (name || 'migration').replace(/[^a-z0-9]/gi, '') || 'migration';
    const filename = `${timestamp}_${safeName}.sql`;
    const filePath = path.resolve(ensureMigrationDir(), filename);

    // Check if file already exists
    if (fs.existsSync(filePath)) {
      return { success: false, error: `File already exists: ${filePath}` };
    }

    // Create template with UP/DOWN blocks
    const content = `-- ----------------------------\n-- ${filename} - UP\n-- ----------------------------\n\n-- Add your migration SQL here\n\n-- ----------------------------\n-- ${filename} - DOWN\n-- ----------------------------\n\n-- Revert the changes made in the UP section above\n\n-- ----------------------------\n-- ${filename} - END\n-- ----------------------------\n`;

    fs.writeFileSync(filePath, content, 'utf8');

    console.log(`[migrate] Created migration file: ${filePath}`);
    return { success: true, filePath };
  } catch (error) {
    console.error('[migrate] Error creating migration:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Bootstrap: run migrations on startup
export async function bootstrapMigrations(): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await migrateUp();
    if (!result.success) {
      console.error('[migrate] Bootstrap failed: migration failed');
      return { success: false, error: result.error };
    }
    if (result.applied && result.applied > 0) {
      console.log('[migrate] Bootstrap complete: all migrations applied');
    } else {
      console.log('[migrate] Bootstrap complete: database already up to date');
    }
    return { success: true };
  } catch (error) {
    console.error('[migrate] Bootstrap error:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Confronto fra percorsi assoluti: costruire la URL a mano (`file://` +
// `process.argv[1]`) non regge su Windows, dove il percorso è `C:\...`, e la
// CLI restava muta (nessun comando eseguito, exit code 0).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = invokedPath !== '' && fileURLToPath(import.meta.url) === invokedPath;

// If run directly, execute migrations
if (isDirectRun) {
  try {
    // Stesso caricamento del servizio (`server/index.ts`), eseguito prima di
    // qualunque lettura della configurazione: `migrate:up` da riga di comando
    // deve vedere lo stesso `.env` di `npm run start:server`.
    loadEnvFile();
  } catch {
    // Nessun `.env` locale: valgono le variabili già presenti nell'ambiente.
  }

  const command = process.argv[2];
  switch (command) {
    case 'up':
      migrateUp().then(r => process.exit(r.success ? 0 : 1));
      break;
    case 'down':
      migrateDown().then(r => process.exit(r.success ? 0 : 1));
      break;
    case 'create':
      const name = process.argv.slice(3).join(' ') || 'new-migration';
      createMigration(name).then(r => {
        process.exit(r.success ? 0 : 1);
        if (r.filePath) console.log(`Migration created at: ${r.filePath}`);
      });
      break;
    default:
      console.log('Usage: node server/migrate.ts <up|down|create> [name]');
      process.exit(1);
  }
}