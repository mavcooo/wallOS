import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMigrationFileName,
  createMigration,
  extractDownSection,
  extractUpSection,
  FALLBACK_MIGRATION_NAME,
  formatMigrationTimestamp,
  kebabCaseMigrationName,
  MIGRATION_FILE_PATTERN,
  MigrationError,
  migrateUp,
  type MigrationConnection,
} from '../migrate.js';

const tempDirs: string[] = [];

/** Cartella temporanea usata come `MIGRATION_DIR` dai test del generatore. */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallos-migration-naming-'));
  tempDirs.push(dir);
  return dir;
}

/** `npm run migrate:create "add solar inverter"` a un istante fissato. */
const FIXED_NOW = new Date('2026-10-29T17:58:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('formatMigrationTimestamp', () => {
  it('produce 14 cifre UTC (YYYYMMDDHHmmss)', () => {
    expect(formatMigrationTimestamp(FIXED_NOW)).toBe('20261029175800');
  });

  it('usa l’orologio UTC, non quello locale, e azzera le cifre singole', () => {
    expect(formatMigrationTimestamp(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '20260102030405',
    );
    // Fine anno: nessun overflow, nessun separatore dalla formattazione ISO.
    expect(formatMigrationTimestamp(new Date('2026-12-31T23:59:59.000Z'))).toBe(
      '20261231235959',
    );
  });
});

describe('kebabCaseMigrationName', () => {
  it.each([
    ['add solar inverter', 'add-solar-inverter'],
    // Spazi multipli e tabulazioni collassano in un solo trattino.
    ['add   solar \t inverter', 'add-solar-inverter'],
    // Underscore e trattini già presenti non si sommano.
    ['add_solar_inverter', 'add-solar-inverter'],
    ['--add--solar--inverter--', 'add-solar-inverter'],
    ['add - solar - inverter', 'add-solar-inverter'],
    // Maiuscole e caratteri speciali.
    ['Add Solar Inverter', 'add-solar-inverter'],
    ['add!!!solar@@@inverter', 'add-solar-inverter'],
    ['  AddSolarInverter  ', 'addsolarinverter'],
    // Gli accenti vengono traslitterati, non eliminati con la lettera.
    ['Aggiungi Città', 'aggiungi-citta'],
    // Numeri e versioni restano leggibili.
    ['Add Zigbee2MQTT v2', 'add-zigbee2mqtt-v2'],
  ])('normalizza %j in %j', (input, expected) => {
    expect(kebabCaseMigrationName(input)).toBe(expected);
  });

  it.each(['', '   ', '-_-', '!!!', '___'])('ripiega su %s quando non resta nulla', (input) => {
    expect(kebabCaseMigrationName(input)).toBe(FALLBACK_MIGRATION_NAME);
  });

  it('rimuove i trattini di testa e di coda anche dopo la sostituzione', () => {
    const slug = kebabCaseMigrationName('  !! add solar inverter ??  ');
    expect(slug).toBe('add-solar-inverter');
    expect(slug.startsWith('-')).toBe(false);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('buildMigrationFileName', () => {
  it('genera il nome conforme: timestamp a 14 cifre + kebab-case', () => {
    const filename = buildMigrationFileName('add solar inverter', FIXED_NOW);
    expect(filename).toBe('20261029175800_add-solar-inverter.sql');
    expect(filename).toMatch(MIGRATION_FILE_PATTERN);
  });

  it('passa il pattern applicato dal lint anche con input disordinato', () => {
    const filename = buildMigrationFileName('  Add__Solar  Inverter!!! ', FIXED_NOW);
    expect(filename).toBe('20261029175800_add-solar-inverter.sql');
    expect(MIGRATION_FILE_PATTERN.test(filename)).toBe(true);
  });

  it('non produce doppi trattini né maiuscole', () => {
    const filename = buildMigrationFileName('Add__Solar---Inverter', FIXED_NOW);
    expect(filename).not.toMatch(/--/);
    expect(filename).toBe('20261029175800_add-solar-inverter.sql');
  });
});

describe('createMigration · file su disco', () => {
  it('scrive il file con il nome normalizzato e il template UP/DOWN/END', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = makeTempDir();

    const result = await createMigration('add solar inverter', { dir, now: FIXED_NOW });

    expect(result.success).toBe(true);
    expect(result.filename).toBe('20261029175800_add-solar-inverter.sql');
    expect(fs.readdirSync(dir)).toEqual(['20261029175800_add-solar-inverter.sql']);

    const content = fs.readFileSync(result.filePath ?? '', 'utf8');
    // Marcatori macchina letti dal runner…
    expect(content).toContain('20261029175800_add-solar-inverter.sql - UP');
    expect(content).toContain('20261029175800_add-solar-inverter.sql - DOWN');
    expect(content).toContain('20261029175800_add-solar-inverter.sql - END');
    // …e le etichette leggibili richieste dal template.
    expect(content).toContain('-- Up Migration');
    expect(content).toContain('-- Down Migration');
  });

  it('genera un file che il runner sa tagliare in due sezioni', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = makeTempDir();
    const result = await createMigration('add solar inverter', { dir, now: FIXED_NOW });
    const sql = fs.readFileSync(result.filePath ?? '', 'utf8');

    // La sezione UP non contiene il DOWN e viceversa: eseguire il file intero
    // applicherebbe anche il rollback.
    const up = extractUpSection(sql);
    const down = extractDownSection(sql);
    expect(up).toContain('-- Up Migration');
    expect(up).not.toContain('-- Down Migration');
    expect(down).not.toBeNull();
    expect(down).toContain('-- Down Migration');
  });

  it('rifiuta un secondo file con lo stesso nome', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = makeTempDir();

    expect((await createMigration('add solar inverter', { dir, now: FIXED_NOW })).success).toBe(
      true,
    );
    const duplicate = await createMigration('add   solar   inverter', { dir, now: FIXED_NOW });

    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toMatch(/already exists|già/i);
  });

  it('rifiuta due migrazioni con lo stesso timestamp, anche con nomi diversi', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = makeTempDir();

    expect((await createMigration('add solar inverter', { dir, now: FIXED_NOW })).success).toBe(
      true,
    );
    const sameSecond = await createMigration('add floorplan schema', { dir, now: FIXED_NOW });

    expect(sameSecond.success).toBe(false);
    expect(sameSecond.error).toMatch(/timestamp/i);
    expect(fs.readdirSync(dir)).toEqual(['20261029175800_add-solar-inverter.sql']);
  });

  it('usa il fallback quando il nome non contiene caratteri utili', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = makeTempDir();

    const result = await createMigration('@@@', { dir, now: FIXED_NOW });
    expect(result.filename).toBe(`20261029175800_${FALLBACK_MIGRATION_NAME}.sql`);
  });
});

describe('createMigration · compatibilità con il ledger', () => {
  it('un nome generato è applicabile e registrato in schema_migrations', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = makeTempDir();
    const created = await createMigration('add naming fixture', { dir, now: FIXED_NOW });

    // Il template nasce con la sola documentazione: qui l'SQL viene scritto
    // nella sezione UP, come farebbe chi crea una migrazione vera.
    fs.writeFileSync(
      created.filePath ?? '',
      `-- ----------------------------\n` +
        `-- ${created.filename} - UP\n` +
        `-- ----------------------------\n` +
        `-- Up Migration\n\n` +
        `CREATE TABLE naming_fixture (id INT PRIMARY KEY);\n\n` +
        `-- ----------------------------\n` +
        `-- ${created.filename} - DOWN\n` +
        `-- ----------------------------\n` +
        `-- Down Migration\n\n` +
        `DROP TABLE naming_fixture;\n`,
      'utf8',
    );

    const executed: string[] = [];
    const connection: MigrationConnection = {
      async query<T>(statement: string) {
        if (statement.includes('pg_try_advisory_xact_lock')) {
          return { rows: [{ locked: true }] as T[] };
        }
        if (statement.includes('SELECT version')) return { rows: [] as T[] };
        executed.push(statement);
        return { rows: [] as T[] };
      },
      async exec(statement: string) {
        executed.push(statement);
      },
    };

    const result = await migrateUp({ connection, dir, log: () => {} });

    expect(result.applied).toEqual([created.filename]);
    expect(executed.join('\n')).toContain('CREATE TABLE naming_fixture');
    // Il ledger riceve il nome del file, cioè la versione: rinominare il file
    // dopo l'applicazione lo farebbe riapplicare.
    const ledgerInsert = executed.find((statement) =>
      statement.includes('INSERT INTO schema_migrations'),
    );
    expect(ledgerInsert).toBeDefined();
  });
});

describe('MigrationError', () => {
  it('espone il codice stabile usato da CLI e log', () => {
    const error = new MigrationError('SQL_ERROR', 'boom');
    expect(error.code).toBe('SQL_ERROR');
    expect(error.name).toBe('MigrationError');
  });
});
