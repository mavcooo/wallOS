#!/usr/bin/env node
/**
 * Verifica deterministica delle convenzioni di naming del progetto.
 *
 * Le regole sono documentate in README.md → "Convenzioni di naming e linee
 * guida file". Questo script è la loro versione eseguibile: stesso esito su ogni
 * macchina, nessuna dipendenza, exit code 1 alla prima categoria con violazioni
 * (ma il report elenca *tutte* le violazioni, così una PR non richiede dieci
 * giri di CI per scoprirle).
 *
 * Uso:
 *   npm run lint:filenames
 *   node tools/lint-naming-conventions.mjs --root <cartella>   # fixture/test
 *
 * Categorie controllate:
 *   - migrazioni SQL   server/migrations/**\/*.sql
 *   - componenti React src/components/**, src/pages/**
 *   - custom hook      src/hooks/**
 *   - moduli/servizi   src/lib, src/services, src/store, src/utils, server/services, ...
 *   - test             *.test.(ts|tsx) / *.spec.(ts|tsx), ovunque in src/ e server/
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index === -1) return REPO_ROOT;
  const value = argv[index + 1];
  if (!value) {
    console.error('[lint:filenames] --root richiede un percorso');
    process.exit(2);
  }
  return resolve(value);
}

const ROOT = parseRoot(process.argv.slice(2));

/** Percorso relativo con separatori POSIX, stabile fra Windows e Linux. */
const rel = (absolute) => relative(ROOT, absolute).split(sep).join('/');

// ---------------------------------------------------------------------------
// Regole
// ---------------------------------------------------------------------------

/** Nuova migrazione: `20261029175800_add-solar-inverter.sql`. */
const NEW_MIGRATION_FILE = /^\d{14}_[a-z0-9]+(-[a-z0-9]+)*\.sql$/;

/**
 * Migrazioni storiche: prefisso sequenziale a tre cifre, distribuite negli
 * ambienti operativi e già registrate in `schema_migrations`. La lista è un
 * **snapshot chiuso**: non cresce più, ogni file nuovo usa il timestamp.
 * `003` è duplicato per scelta (due migrazioni dello stesso giorno, prima del
 * ledger): rinominarne una disallineerebbe il ledger dei DB già migrati.
 */
const LEGACY_MIGRATIONS = Object.freeze([
  '001_initial_schema.sql',
  '002_add_camera_entity.sql',
  '003_add_climate_schedules.sql',
  '003_telemetry_history.sql',
  '004_automations.sql',
  '005_automation_condition_groups.sql',
  '006_kiosk_displays.sql',
  '007_add_floorplan_schema.sql',
  '008_add_db_health_checks.sql',
  '009_security_system.sql',
]);
const LEGACY_MIGRATION_SET = new Set(LEGACY_MIGRATIONS);

/** Qualunque file con un prefisso numerico corto: è la forma legacy. */
const LEGACY_STYLE_MIGRATION = /^\d{1,3}_/;

/** Componente React: PascalCase, estensione `.tsx`. */
const COMPONENT_FILE = /^[A-Z][a-zA-Z0-9]*\.tsx$/;

/**
 * Primitivi UI (shadcn/Radix) in `src/components/ui/`: kebab-case minuscolo,
 * come li distribuisce il generatore shadcn. È l'unica eccezione al PascalCase,
 * confinata alla directory dei primitivi.
 */
const UI_PRIMITIVE_FILE = /^[a-z0-9]+(-[a-z0-9]+)*\.tsx$/;

/**
 * File sotto `src/components/` che non sono componenti ma moduli condivisi
 * (costanti e helper di form). Restano `.tsx` perché esportano JSX.
 */
const COMPONENT_MODULE_EXCEPTIONS = new Set(['src/components/admin/fields.tsx']);

/** Custom hook: `use` + PascalCase, `.ts` o `.tsx`. */
const HOOK_FILE = /^use[A-Z][a-zA-Z0-9]+\.(ts|tsx)$/;

/** Modulo, servizio, store, utility: camelCase. */
const MODULE_FILE = /^[a-z][a-zA-Z0-9]*\.ts$/;

/** Test: il nome del target seguito da `.test`/`.spec` e dall'estensione. */
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

const isTestFile = (path) => TEST_FILE.test(path);

/** Directory con file-modulo in camelCase (il resto del progetto è React/CLI). */
const MODULE_DIRS = [
  'src/lib',
  'src/services',
  'src/store',
  'src/utils',
  'server/services',
  'server/routes',
  'server/utils',
];

const COMPONENT_DIRS = ['src/components', 'src/pages'];

/** File di indice e jest-dom setup non sono componenti. */
const isIndexOrConfig = (name) => /^index\.(ts|tsx)$/.test(name);

// ---------------------------------------------------------------------------
// Raccolta file
// ---------------------------------------------------------------------------

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...walk(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function filesUnder(dir) {
  const absolute = resolve(ROOT, dir);
  try {
    if (!statSync(absolute).isDirectory()) return [];
  } catch {
    return [];
  }
  return walk(absolute).map(rel).sort();
}

// ---------------------------------------------------------------------------
// Controlli
// ---------------------------------------------------------------------------

/** @type {{ file: string, rule: string, message: string }[]} */
const violations = [];
const add = (file, rule, message) => violations.push({ file, rule, message });

function checkMigrations() {
  const files = filesUnder('server/migrations').filter((file) => file.endsWith('.sql'));
  const newTimestamps = new Map();

  for (const path of files) {
    const name = path.slice('server/migrations/'.length);

    if (LEGACY_MIGRATION_SET.has(name)) {
      // Storica e ammessa: nome congelato, nessun controllo di pattern né di
      // unicità del prefisso (003 è duplicato di proposito).
      continue;
    }

    if (!NEW_MIGRATION_FILE.test(name)) {
      const hint = LEGACY_STYLE_MIGRATION.test(name)
        ? 'il prefisso sequenziale è chiuso alle migrazioni storiche: usa `npm run migrate:create "<descrizione>"`'
        : 'formato atteso: YYYYMMDDHHmmss_descrizione-in-kebab-case.sql (minuscolo)';
      add(path, 'migrations', `nome non conforme — ${hint}`);
      continue;
    }

    const timestamp = name.slice(0, 14);
    const previous = newTimestamps.get(timestamp);
    if (previous) {
      add(
        path,
        'migrations',
        `timestamp duplicato (${timestamp}): già usato da ${previous}; l'ordine di applicazione sarebbe ambiguo`,
      );
    } else {
      newTimestamps.set(timestamp, name);
    }
  }
}

function checkComponents() {
  for (const dir of COMPONENT_DIRS) {
    for (const path of filesUnder(dir)) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (isTestFile(path) || isIndexOrConfig(name)) continue;

      if (!path.endsWith('.tsx')) {
        // Sotto components/ un `.ts` è un modulo: deve comunque essere camelCase.
        if (!MODULE_FILE.test(name)) {
          add(path, 'components', 'modulo in components/ non camelCase');
        }
        continue;
      }

      if (COMPONENT_MODULE_EXCEPTIONS.has(path)) continue;

      // In `src/components/ui/` convivono i primitivi shadcn (kebab-case) e i
      // componenti applicativi (PascalCase): entrambe le forme sono valide, il
      // resto no.
      const inUiPrimitives = path.startsWith('src/components/ui/');
      const valid = inUiPrimitives
        ? COMPONENT_FILE.test(name) || UI_PRIMITIVE_FILE.test(name)
        : COMPONENT_FILE.test(name);
      if (!valid) {
        add(
          path,
          'components',
          inUiPrimitives
            ? 'file in components/ui non PascalCase né kebab-case (es. LivePowerCard.tsx, toggle-group.tsx)'
            : 'componente React non PascalCase (es. LivePowerCard.tsx)',
        );
      }
    }
  }
}

function checkHooks() {
  for (const path of filesUnder('src/hooks')) {
    if (isTestFile(path)) continue;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!HOOK_FILE.test(name)) {
      add(path, 'hooks', 'hook non conforme: atteso usePascalCase.ts / usePascalCase.tsx');
    }
  }
}

function checkModules() {
  for (const dir of MODULE_DIRS) {
    for (const path of filesUnder(dir)) {
      if (isTestFile(path)) continue;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!MODULE_FILE.test(name)) {
        add(path, 'modules', 'modulo/servizio non camelCase (es. telemetryWorker.ts)');
      }
    }
  }
}

function checkTests() {
  const seen = new Set();
  for (const dir of ['src', 'server']) {
    for (const path of filesUnder(dir)) {
      if (seen.has(path)) continue;
      seen.add(path);

      const inTestsDir = path.includes('/__tests__/');
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (isTestFile(path)) continue;

      // Un file in __tests__/ deve dichiararsi test: altrimenti né Vitest né il
      // lint sanno cosa farne.
      if (inTestsDir && /\.(ts|tsx)$/.test(name)) {
        add(path, 'tests', 'file in __tests__/ senza suffisso .test.ts / .test.tsx');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

checkMigrations();
checkComponents();
checkHooks();
checkModules();
checkTests();

const ruleLabels = {
  migrations: 'Migrazioni SQL',
  components: 'Componenti React',
  hooks: 'Custom hook',
  modules: 'Moduli / servizi',
  tests: 'Test',
};

if (violations.length === 0) {
  console.log('[lint:filenames] ok · nessuna violazione delle convenzioni di naming');
  process.exit(0);
}

console.error(`[lint:filenames] ${violations.length} violazione(i) delle convenzioni di naming:`);
for (const rule of Object.keys(ruleLabels)) {
  const group = violations.filter((violation) => violation.rule === rule);
  if (group.length === 0) continue;
  console.error(`\n  ${ruleLabels[rule]}`);
  for (const violation of group) {
    console.error(`    ✗ ${violation.file}`);
    console.error(`      ${violation.message}`);
  }
}
console.error('\nRegole: README.md → "Convenzioni di naming e linee guida file".');
process.exit(1);
