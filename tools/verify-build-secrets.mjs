#!/usr/bin/env node
/**
 * Verifica post-build del bundle statico (gate di sicurezza per CI/CD).
 *
 * Perché esiste: `envPrefix` in `vite.config.ts` espone al browser solo le
 * variabili `VITE_*`, ma una distrazione (un `VITE_MQTT_PASSWORD` aggiunto al
 * `.env`, un `define` copiato da un altro progetto) rimetterebbe un segreto
 * dentro `dist/`. Questo script è l'ultima rete: scansiona gli asset compilati
 * e fallisce il build se trova:
 *
 * - il valore (lungo almeno 12 caratteri) di una variabile d'ambiente con nome
 *   sensibile (PASSWORD, SECRET, TOKEN, KEY, ...), letto da `.env*` o dal
 *   processo;
 * - un riferimento esplicito a variabili come `MQTT_PASSWORD` o `JWT_SECRET`;
 * - URL PostgreSQL/MQTT con credenziali o una chiave privata PEM.
 *
 * Uso:
 *   node tools/verify-build-secrets.mjs
 *   node tools/verify-build-secrets.mjs --dir dist --env-file .env
 *
 * Le occorrenze vengono riportate senza stampare il valore: il log di CI non
 * deve diventare a sua volta una fuga di segreti.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Asset testuali che possono contenere una stringa finita nel bundle. */
const SCANNED_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
  '.map',
  '.txt',
]);

/** Nome di variabile che, per convenzione, contiene un segreto. */
const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIALS?)/i;

/**
 * Sotto questa soglia un valore non viene cercato come stringa: parole brevi
 * come `wallos` coinciderebbero con i topic del progetto e produrrebbero solo
 * falsi positivi. Le credenziali corte restano coperte dai controlli
 * strutturali (URL con password, riferimenti a variabili, chiavi PEM).
 */
const MIN_VALUE_LENGTH = 12;

/** Valori di template/demo: non sono segreti e non devono bloccare il build. */
const PLACEHOLDER_VALUES = new Set([
  'password',
  'password123',
  'changeme',
  'change-me',
  'secret',
  'undefined',
  'null',
  'true',
  'false',
  '0',
  '1',
  'your_secure_password',
  'your-password',
]);

/**
 * Nomi che il codice client non deve nemmeno citare: se compaiono in `dist/`
 * significa che un percorso di configurazione server è finito nel browser.
 */
const FORBIDDEN_MARKERS = [
  'MQTT_PASSWORD',
  'MOSQUITTO_BACKEND_PASSWORD',
  'MOSQUITTO_KIOSK_PASSWORD',
  'MOSQUITTO_SIM_PASSWORD',
  'DB_PASSWORD',
  'JWT_SECRET',
  'ADMIN_PASSWORD',
  'ADMIN_PIN',
  'KIOSK_PIN',
];

/** Credenziali incorporate in URL o chiavi private, indipendenti dall'ambiente. */
const CREDENTIAL_PATTERNS = [
  {
    name: 'URL PostgreSQL con credenziali',
    regex: /postgres(?:ql)?:\/\/[^\s"'`<>\\/]+:[^\s"'`<>\\/@]+@/i,
  },
  {
    name: 'URL MQTT con credenziali',
    regex: /mqtts?:\/\/[^\s"'`<>\\/]+:[^\s"'`<>\\/@]+@/i,
  },
  {
    name: 'chiave privata PEM',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  },
];

function fail(message) {
  console.error(`[verify-build-secrets] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { dir: 'dist', envFiles: null, quiet: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dir' || arg.startsWith('--dir=')) {
      const value = arg === '--dir' ? argv[(index += 1)] : arg.slice('--dir='.length);
      if (!value) fail('--dir richiede un percorso');
      options.dir = value;
    } else if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      const value =
        arg === '--env-file' ? argv[(index += 1)] : arg.slice('--env-file='.length);
      if (!value) fail('--env-file richiede un percorso');
      options.envFiles = options.envFiles ?? [];
      options.envFiles.push(value);
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Uso: node tools/verify-build-secrets.mjs [--dir dist] [--env-file .env] [--quiet]',
      );
      process.exit(0);
    } else {
      fail(`argomento non riconosciuto: ${arg} (usa --help)`);
    }
  }

  return options;
}

/** `.env`, `.env.local`, `.env.production`, ... — mai i template `.example`. */
function discoverEnvFiles() {
  return readdirSync(ROOT)
    .filter((name) => name === '.env' || (name.startsWith('.env.') && !name.endsWith('.example')))
    .map((name) => join(ROOT, name));
}

function parseEnvFile(path) {
  const entries = {};
  const content = readFileSync(path, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }

  return entries;
}

function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(value.toLowerCase());
}

/**
 * Raccoglie i valori da cercare. Le variabili `VITE_*` con nome sensibile sono
 * già un errore: Vite le includerebbe nel bundle per definizione.
 */
function collectSecrets(envFiles) {
  const secrets = new Map();
  const publicLeaks = [];

  const add = (key, value) => {
    if (!SECRET_NAME.test(key)) return;
    if (key.startsWith('VITE_')) publicLeaks.push(key);

    const clean = typeof value === 'string' ? value.trim() : '';
    if (clean.length < MIN_VALUE_LENGTH || isPlaceholder(clean)) return;
    if (!secrets.has(clean)) secrets.set(clean, key);
  };

  for (const [key, value] of Object.entries(process.env)) add(key, value);
  for (const file of envFiles) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvFile(file))) add(key, value);
  }

  return { secrets, publicLeaks: [...new Set(publicLeaks)] };
}

/** Varianti con cui un valore può finire serializzato in JS/HTML. */
function valueVariants(value) {
  const variants = new Set([value, JSON.stringify(value).slice(1, -1)]);
  try {
    const encoded = encodeURIComponent(value);
    if (encoded !== value) variants.add(encoded);
  } catch {
    // Una stringa malformata per encodeURIComponent resta cercata così com'è.
  }
  return [...variants].filter((variant) => variant.length >= MIN_VALUE_LENGTH);
}

function walkAssets(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkAssets(absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCANNED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    files.push(absolute);
  }

  return files.sort();
}

function scanAsset(file, content, secrets) {
  const findings = [];
  const seen = new Set();
  const report = (reason) => {
    if (seen.has(reason)) return;
    seen.add(reason);
    findings.push(reason);
  };

  for (const [secret, key] of secrets) {
    if (valueVariants(secret).some((variant) => content.includes(variant))) {
      report(`valore di ${key}`);
    }
  }

  for (const marker of FORBIDDEN_MARKERS) {
    if (content.includes(marker)) report(`riferimento a ${marker}`);
  }

  for (const { name, regex } of CREDENTIAL_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(content)) report(name);
  }

  return findings;
}

const options = parseArgs(process.argv.slice(2));
const distDir = resolve(process.cwd(), options.dir);

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  fail(`cartella non trovata: ${distDir}. Esegui prima il build (vite build).`);
}

const envFiles = options.envFiles
  ? options.envFiles.map((file) => resolve(process.cwd(), file))
  : discoverEnvFiles();
const { secrets, publicLeaks } = collectSecrets(envFiles);
const assets = walkAssets(distDir);

if (assets.length === 0) {
  fail(`nessun asset testuale in ${distDir}: build incompleto o cartella errata.`);
}

const findings = [];

for (const asset of assets) {
  const content = readFileSync(asset, 'utf8');
  for (const reason of scanAsset(asset, content, secrets)) {
    findings.push({ file: relative(distDir, asset).split('\\').join('/'), reason });
  }
}

if (publicLeaks.length > 0) {
  console.error(
    `[verify-build-secrets] variabili VITE_ con nome sensibile: ${publicLeaks.join(', ')}`,
  );
  console.error('  Vite le includerebbe nel bundle: rinominale o rimuovile dal .env.');
}

for (const finding of findings) {
  console.error(`[verify-build-secrets] ${finding.file}: ${finding.reason}`);
}

if (findings.length > 0 || publicLeaks.length > 0) {
  console.error(
    `[verify-build-secrets] BLOCCATO: ${findings.length} occorrenza/e in ${assets.length} asset. ` +
      'Rimuovi il segreto dal bundle e ruota la credenziale.',
  );
  process.exit(1);
}

if (!options.quiet) {
  console.log(
    `[verify-build-secrets] OK: ${assets.length} asset, ${secrets.size} segreti noti, ` +
      'nessuna credenziale trovata.',
  );
}
