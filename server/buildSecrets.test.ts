import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Il gate di build è uno script Node separato: qui lo si esegue su fixture
 * temporanee, così una regressione che rimette un segreto in `dist/` fallisce
 * in `npm run test:server` e non solo in produzione.
 */
const SCRIPT = fileURLToPath(new URL('../tools/verify-build-secrets.mjs', import.meta.url));
const CANARY = 'wallos-canary-9f3b7c1d';
const tempDirs: string[] = [];

function fixture(files: Record<string, string>, env = '') {
  const root = mkdtempSync(join(tmpdir(), 'wallos-bundle-'));
  tempDirs.push(root);

  const base: Record<string, string> = {
    'index.html': '<!doctype html><script type="module" src="/assets/app.js"></script>',
    'assets/app.js': 'console.log("wallos");',
    ...files,
  };

  for (const [name, content] of Object.entries(base)) {
    const target = join(root, 'dist', name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const envFile = join(root, '.env.fixture');
  writeFileSync(envFile, env);

  return { dist: join(root, 'dist'), envFile, root };
}

function run(dist: string, envFile: string) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--dir', dist, '--env-file', envFile, '--quiet'],
    {
      encoding: 'utf8',
      env: { ...process.env, MQTT_PASSWORD: CANARY },
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('verify-build-secrets', () => {
  it('passa su un bundle pulito anche con un segreto noto nell’ambiente', () => {
    const { dist, envFile } = fixture({}, `MQTT_PASSWORD=${CANARY}\n`);

    const result = run(dist, envFile);

    expect(result.stderr).not.toContain(CANARY);
    expect(result.status).toBe(0);
  });

  it('non confonde un valore corto con il testo normale del progetto', () => {
    const { dist, envFile } = fixture(
      { 'assets/app.js': 'const topic = "wallos/heartbeat/ping";' },
      'DB_PASSWORD=wallos\n',
    );

    const result = run(dist, envFile);

    expect(result.status).toBe(0);
  });

  it('blocca il build se il valore di un segreto compare in un asset', () => {
    const { dist, envFile } = fixture(
      { 'assets/app.js': `const password = "${CANARY}";` },
      `MQTT_PASSWORD=${CANARY}\n`,
    );

    const result = run(dist, envFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assets/app.js');
    expect(result.stderr).toContain('valore di MQTT_PASSWORD');
    // Il log non deve ripetere il segreto trovato.
    expect(result.stderr).not.toContain(CANARY);
  });

  it('blocca un URL PostgreSQL con credenziali anche senza variabili d’ambiente', () => {
    const { dist, envFile } = fixture({
      'assets/app.js': 'const url = "postgres://wallos:s3cret@192.168.0.59:5432/wallos";',
    });

    const result = run(dist, envFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('URL PostgreSQL con credenziali');
  });

  it('blocca i riferimenti a variabili riservate del server', () => {
    const { dist, envFile } = fixture({
      'assets/app.js': 'const key = "JWT_SECRET";',
    });

    const result = run(dist, envFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('riferimento a JWT_SECRET');
  });

  it('rifiuta una variabile VITE_ con nome sensibile', () => {
    const { dist, envFile } = fixture({}, 'VITE_MQTT_PASSWORD=non-deve-essere-pubblica\n');

    const result = run(dist, envFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('variabili VITE_ con nome sensibile');
    expect(result.stderr).toContain('VITE_MQTT_PASSWORD');
  });

  it('fallisce se dist non esiste o non contiene asset', () => {
    const { root, envFile } = fixture({});

    const missing = spawnSync(
      process.execPath,
      [SCRIPT, '--dir', join(root, 'dist-missing'), '--env-file', envFile, '--quiet'],
      { encoding: 'utf8' },
    );

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('cartella non trovata');
  });
});
