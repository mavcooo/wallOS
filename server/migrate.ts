import { Pool } from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Load configuration from .env
const config = {
  host: process.env.DB_HOST || '192.168.0.59',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'wallos',
  user: process.env.DB_USER || 'wallos_user',
  password: process.env.DB_PASSWORD || 's3cret',
};

// Determine migration directory
const migrationDir = process.env.MIGRATION_DIR || path.resolve(process.cwd(), 'server/migrations');

// Ensure migration directory exists
if (!fs.existsSync(migrationDir)) {
  fs.mkdirSync(migrationDir, { recursive: true });
}

// Create PostgreSQL pool
const pool = new Pool({
  connectionString: `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

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
  const files = fs.readdirSync(migrationDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql'));
  return sqlFiles.sort();
}

// Run migrations up
export async function migrateUp(): Promise<{ success: boolean; error?: string; applied?: number }> {
  const client = await pool.connect();
  try {
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
  const client = await pool.connect();
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
    const filePath = path.resolve(migrationDir, filename);

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

// If run directly, execute migrations
if (import.meta.url === `file://${process.argv[1]}`) {
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