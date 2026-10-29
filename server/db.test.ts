import { describe, expect, it } from 'vitest';

import {
  checkDatabaseConnection,
  describeDatabaseError,
  describeDatabaseTarget,
  type SqlClient,
} from './db.js';

const DATABASE_URL = 'postgres://wallos_user:s3cret@192.168.0.59:5432/wallos';

function clientResolving(info: {
  version: string;
  database: string;
  username: string;
}): SqlClient {
  return {
    async query<T>() {
      return { rows: [info] as T[], rowCount: 1 };
    },
    async exec() {},
  };
}

describe('diagnostica della connessione PostgreSQL', () => {
  it('descrive la destinazione senza esporre utente e password', () => {
    const target = describeDatabaseTarget(DATABASE_URL);
    expect(target).toBe('192.168.0.59:5432/wallos');
    expect(target).not.toContain('s3cret');
    expect(target).not.toContain('wallos_user');
  });

  it('logga l’esito del check di avvio in una riga compatta e senza segreti', async () => {
    const lines: string[] = [];
    const info = await checkDatabaseConnection(
      clientResolving({
        version: 'PostgreSQL 17.4 on x86_64-pc-linux-gnu',
        database: 'wallos',
        username: 'wallos_user',
      }),
      {
        connectionString: DATABASE_URL,
        source: 'DATABASE_URL',
        log: (message) => lines.push(message),
      },
    );

    expect(info).toMatchObject({ version: 'PostgreSQL 17.4 on x86_64-pc-linux-gnu', user: 'wallos_user' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[db] connesso · 192.168.0.59:5432/wallos');
    expect(lines[0]).toContain('PostgreSQL 17.4 · config DATABASE_URL');
    // Nessuna credenziale nei log di routine, nemmeno il nome utente.
    expect(lines[0]).not.toContain('wallos_user');
    expect(lines[0]).not.toContain('s3cret');
  });

  it('rilancia l’errore e lo traduce in un messaggio operativo', async () => {
    const failing: SqlClient = {
      async query() {
        throw Object.assign(new Error('connect ECONNREFUSED 192.168.0.59:5432'), {
          code: 'ECONNREFUSED',
        });
      },
      async exec() {},
    };

    await expect(
      checkDatabaseConnection(failing, { connectionString: DATABASE_URL }),
    ).rejects.toThrow(/ECONNREFUSED/);

    const reason = describeDatabaseError(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      DATABASE_URL,
    );
    expect(reason).toContain('Nessun PostgreSQL in ascolto su 192.168.0.59:5432/wallos');
    expect(reason).not.toContain('s3cret');
  });

  it('anche l’errore di autenticazione non riporta il ruolo del database', () => {
    const reason = describeDatabaseError(
      Object.assign(new Error('password authentication failed'), { code: '28P01' }),
      DATABASE_URL,
    );

    expect(reason).toContain('192.168.0.59:5432/wallos');
    expect(reason).not.toContain('wallos_user');
    expect(reason).not.toContain('s3cret');
  });
});
