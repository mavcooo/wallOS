import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  INVALID_DATABASE_TARGET,
  formatStartupMessage,
  sanitizeDatabaseUrl,
} from '../utils/sanitize.js';

/**
 * Segreto "sentinella": se compare in un output di log il test fallisce
 * immediatamente. La password non è mai una costante reale del progetto.
 */
const CANARY_SECRET = 'SUPER_SECRET_CANARY_PASSWORD_XYZ';
const CANARY_USER = 'wallos_user';
const CANARY_URL = `postgres://${CANARY_USER}:${CANARY_SECRET}@192.168.0.59:5432/wallos_db?sslmode=disable`;

describe('sanitizeDatabaseUrl', () => {
  it('restituisce solo host, porta e nome del database', () => {
    expect(sanitizeDatabaseUrl(CANARY_URL)).toBe('192.168.0.59:5432/wallos_db');
  });

  it('non lascia trapelare né la password né l’utente', () => {
    const output = sanitizeDatabaseUrl(CANARY_URL);
    expect(output).not.toContain(CANARY_SECRET);
    expect(output).not.toContain(CANARY_USER);
    // La query string può veicolare token/opzioni: non deve mai passare.
    expect(output).not.toContain('sslmode');
  });

  it('gestisce schema postgresql, porta implicita e password codificate', () => {
    expect(sanitizeDatabaseUrl('postgresql://utente:p%40ss@db.local/wallos')).toBe(
      'db.local:5432/wallos',
    );
  });

  it('una URL non parsabile non viene mai rimandata indietro', () => {
    const malformed = `postgres://${CANARY_USER}:${CANARY_SECRET}@[::/wallos`;
    const output = sanitizeDatabaseUrl(malformed);
    expect(output).toBe(INVALID_DATABASE_TARGET);
    expect(output).not.toContain(CANARY_SECRET);
    expect(output).not.toContain(CANARY_USER);
  });
});

describe('riga di avvio del servizio', () => {
  it('riporta host, porta e database senza credenziali', () => {
    const output = formatStartupMessage({
      host: '0.0.0.0',
      port: 8787,
      databaseUrl: CANARY_URL,
    });

    expect(output).toBe(
      'auth pronta · http://0.0.0.0:8787 · db 192.168.0.59:5432/wallos_db',
    );
    expect(output).not.toContain(CANARY_SECRET);
    expect(output).not.toContain(CANARY_USER);
  });

  it('il bootstrap usa il formatter sanitizzato, non config.databaseUrl', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).toContain('formatStartupMessage(config)');
    expect(source).not.toContain('db ${config.databaseUrl}');
  });
});
