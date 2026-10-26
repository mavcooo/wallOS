#!/usr/bin/env node
/**
 * tools/db-backup.mjs
 * Script di backup e ripristino per PostgreSQL wallos.
 *
 * Funzionalità:
 *   - Genera dump compressi con pg_dump e gzip
 *   - Pulizia retention (ultimi N giorni o ultimi N file)
 *   - Comando --restore per ripristinare un backup
 *   - Istruzioni per schedulare con cron
 *
 * Nomenclatura file: wallos_backup_YYYY-MM-DD_HH-mm-ss.sql.gz
 * Destinazione predefinita: BACKUP_DIR (default ./backups)
 */

import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { parse } from 'node:path';
import { createInterface } from 'node:readline';

import { createPool, closePool } from '../server/db.js';

// Load environment variables from .env
import 'dotenv/config';

const DB_HOST = process.env.DB_HOST || '192.168.0.59';
const DB_PORT = process.env.DB_PORT || '5432';
const DB_NAME = process.env.DB_NAME || 'wallos';
const DB_USER = process.env.DB_USER || 'wallos_user';
const DB_PASSWORD = process.env.DB_PASSWORD || 's3cret';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '7', 10);
const RETENTION_COUNT = parseInt(process.env.RETENTION_COUNT || '10', 10);

let restoreFilepath = null;

// Parse CLI arguments
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--restore' && i + 1 < args.length) {
    restoreFilepath = args[i + 1];
    i++;
  }
}

async function createPool() {
  const pool = createPool({
    connectionString: `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`,
    max: 5,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

async function listBackups() {
  await mkdir(BACKUP_DIR, { recursive: true });
  const files = await readdir(BACKUP_DIR);
  const backups = [];

  for (const file of files) {
    const match = file.match(/^wallos_backup_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.sql\.gz$/);
    if (match) {
      const date = new Date(`${match[1]}T${match[2]}:00:00+00:00`);
      backups.push({
        filename: file,
        date,
        filepath: `${BACKUP_DIR}/${file}`,
      });
    }
  }

  return backups.sort((a, b) => b.date - a.date);
}

async function cleanupOldBackups(backups) {
  if (backups.length <= RETENTION_COUNT) {
    console.log(`[backup] Mantenimento ${backups.length} backup (sotto il limite di ${RETENTION_COUNT})`);
    return;
  }

  // Se RETENTION_DAYS è impostato, filtrare per età
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

  const toDelete = backups
    .filter(b => b.date < cutoffDate)
    .slice(RETENTION_COUNT);

  if (toDelete.length === 0) {
    console.log('[backup] Nessimo backup vecchio da rimuovere (basato su giorni)');
    return;
  }

  console.log(`[backup] Rimozione ${toDelete.length} backup vecchio${toDelete.length !== 1 ? 'i' : ''}`);

  for (const backup of toDelete) {
    try {
      await unlink(backup.filepath);
      console.log(`  ↳ Eliminato: ${backup.filename}`);
    } catch (err) {
      console.error(`[backup] Errore eliminando ${backup.filename}:`, err.message);
    }
  }
}

async function generateBackup() {
  const timestamp = new Date();
  const dateStr = timestamp.toISOString().split('T')[0];
  const timeStr = timestamp.toTimeString().split(' ')[0].replace(/:/g, '-').replace(/\..+/, '');
  const filename = `wallos_backup_${dateStr}_${timeStr}.sql.gz`;
  const filepath = `${BACKUP_DIR}/${filename}`;

  await mkdir(BACKUP_DIR, { recursive: true });

  console.log(`[backup] Generazione dump: ${filename}`);

  try {
    // Esegui pg_dump con compressione gzip
    execSync(
      `PGPASSWORD=${DB_PASSWORD} pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} --no-owner --no-acl | gzip > "${filepath}"`,
      { stdio: 'pipe' }
    );

    console.log(`[backup] Backup completato: ${filepath}`);

    // Pulizia old backups
    const backups = await listBackups();
    await cleanupOldBackups(backups);

    return filepath;
  } catch (error) {
    console.error('[backup] Errore durante il backup:', error.message);
    // Cleanup parziale se il file è stato creato ma compresso fallito
    try { await unlink(filepath); } catch {}
    throw error;
  }
}

async function restoreBackup(backupPath) {
  console.log(`[backup] Ripristino da: ${backupPath}`);

  // Verifica che il file esista
  try {
    await stat(backupPath);
  } catch (error) {
    console.error(`[backup] File non trovato: ${backupPath}`);
    process.exit(1);
  }

  // Chiudi eventuali connessioni esistenti
  try { await closePool(); } catch {}

  // Esegui pg_restore per decompressere e ripristinare
  try {
    execSync(
      `PGPASSWORD=${DB_PASSWORD} pg_restore -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} --no-owner --no-acl --clean "${backupPath}"`,
      { stdio: 'pipe' }
    );
    console.log('[backup] Ripristino completato con successo');
  } catch (error) {
    console.error('[backup] Errore durante il ripristino:', error.message);
    process.exit(1);
  }
}

async function main() {
  if (restoreFilepath) {
    await restoreBackup(restoreFilepath);
    return;
  }

  await generateBackup();
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exit(1);
});

// Helper: mostra istruzioni cron
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
================================================================================
Istruzioni per la schedulazione con cron (sistemi Unix/Linux):

  # Esegui backup giornaliero alle 03:00 del mattino
  0 3 * * * /usr/local/bin/node $(pwd)/tools/db-backup.mjs >> $(pwd)/tools/backup.log 2>&1

  # Esegui backup ogni ora (per test)
  0 * * * * /usr/local/bin/node $(pwd)/tools/db-backup.mjs >> $(pwd)/tools/backup.log 2>&1

  # Per vedere i backup conservati (retention 7 giorni di default):
  npm run db:backup

================================================================================
Variabili d'ambiente .env opzionali:

  BACKUP_DIR=./backups            # Directory di destinazione (default ./backups)
  RETENTION_DAYS=7                # Mantieni gli ultimi N giorni di backup
  RETENTION_COUNT=10              # Mantieni gli ultimi N file di backup

================================================================================
  `);
}