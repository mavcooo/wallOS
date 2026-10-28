import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
  ADMIN_PASSWORD: 'admin-password-123',
  ADMIN_PIN: '2468',
  KIOSK_PIN: '1234',
};

const GRANULAR = {
  DB_HOST: '192.168.0.59',
  DB_PORT: '5432',
  DB_NAME: 'wallos',
  DB_USER: 'wallos_user',
  DB_PASSWORD: 'your_secure_password',
};

describe('seed demo', () => {
  it('è disattivato per default: il bootstrap non scrive dati mock', () => {
    expect(loadConfig({ ...BASE_ENV, ...GRANULAR }).seed.autoSeed).toBe(false);
  });

  it('si attiva solo con AUTO_SEED=true', () => {
    expect(loadConfig({ ...BASE_ENV, ...GRANULAR, AUTO_SEED: 'true' }).seed.autoSeed).toBe(true);
    expect(loadConfig({ ...BASE_ENV, ...GRANULAR, AUTO_SEED: 'false' }).seed.autoSeed).toBe(false);
  });

  it('rifiuta un valore ambiguo invece di interpretarlo come spento', () => {
    expect(() => loadConfig({ ...BASE_ENV, ...GRANULAR, AUTO_SEED: 'forse' })).toThrowError(
      /AUTO_SEED deve essere true o false/,
    );
  });
});

describe('configurazione PostgreSQL', () => {
  it('costruisce DATABASE_URL dalle variabili granulari, codificando le credenziali', () => {
    const config = loadConfig({
      ...BASE_ENV,
      ...GRANULAR,
      DB_PASSWORD: 'p@ss word',
    });

    expect(config.databaseUrl).toBe(
      'postgres://wallos_user:p%40ss%20word@192.168.0.59:5432/wallos',
    );
    expect(config).toMatchObject({
      databaseUrlSource: 'DB_*',
      dbHost: '192.168.0.59',
      dbPort: 5432,
      dbName: 'wallos',
      dbUser: 'wallos_user',
    });
  });

  it('accetta DATABASE_URL come fonte principale anche senza DB_*', () => {
    const config = loadConfig({
      ...BASE_ENV,
      DATABASE_URL: 'postgres://wallos_user:your_secure_password@192.168.0.59:5432/wallos',
    });

    expect(config.databaseUrlSource).toBe('DATABASE_URL');
    expect(config).toMatchObject({
      dbHost: '192.168.0.59',
      dbPort: 5432,
      dbName: 'wallos',
      dbUser: 'wallos_user',
    });
  });

  it('blocca l’avvio senza alcuna configurazione del database', () => {
    expect(() => loadConfig({ ...BASE_ENV })).toThrowError(
      /Configurazione PostgreSQL assente: imposta DATABASE_URL/,
    );
  });

  it('elenca le variabili DB_* mancanti', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DB_HOST: '192.168.0.59', DB_PORT: '5432', DB_NAME: 'wallos' }),
    ).toThrowError(/mancanti.*DB_USER, DB_PASSWORD/);
  });

  it('rifiuta una URL che contraddice le variabili granulari', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        ...GRANULAR,
        DB_HOST: '127.0.0.1',
        DATABASE_URL: 'postgres://wallos_user:your_secure_password@192.168.0.59:5432/wallos',
      }),
    ).toThrowError(/DATABASE_URL non concorda con DB_HOST/);
  });

  it('rifiuta URL non PostgreSQL o senza database', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DATABASE_URL: 'mysql://u:p@192.168.0.59:3306/wallos' }),
    ).toThrowError(/schema postgres:\/\/ o postgresql:\/\//);

    expect(() =>
      loadConfig({ ...BASE_ENV, DATABASE_URL: 'postgres://u:p@192.168.0.59:5432' }),
    ).toThrowError(/senza nome del database/);
  });

  it('rifiuta porta e impostazioni del pool malformate', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        ...GRANULAR,
        DB_PORT: '70000',
      }),
    ).toThrowError(/DB_PORT deve essere una porta TCP valida/);

    expect(() =>
      loadConfig({
        ...BASE_ENV,
        ...GRANULAR,
        DATABASE_POOL_MAX: '0',
        DATABASE_SSL: 'forse',
      }),
    ).toThrowError(/DATABASE_POOL_MAX.*DATABASE_SSL/s);
  });

  it('applica i default del pool e li legge dalle variabili dedicate', () => {
    const defaults = loadConfig({ ...BASE_ENV, ...GRANULAR });
    expect(defaults).toMatchObject({
      dbPoolMax: 10,
      dbIdleTimeoutMs: 30_000,
      dbConnectTimeoutMs: 5_000,
      dbSsl: false,
    });

    const custom = loadConfig({
      ...BASE_ENV,
      ...GRANULAR,
      DATABASE_POOL_MAX: '25',
      DATABASE_IDLE_TIMEOUT_MS: '15000',
      DATABASE_CONNECT_TIMEOUT_MS: '8000',
      DATABASE_SSL: 'true',
    });
    expect(custom).toMatchObject({
      dbPoolMax: 25,
      dbIdleTimeoutMs: 15_000,
      dbConnectTimeoutMs: 8_000,
      dbSsl: true,
    });
  });
});
