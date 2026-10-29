/**
 * Sanitizzazione delle stringhe di connessione PostgreSQL destinate ai log.
 *
 * Una `DATABASE_URL` contiene di norma `utente:password` in chiaro. Docker
 * logs, raccoglitori centralizzati (Loki, Graylog, Datadog) e ticket di
 * assistenza non devono mai riceverla: qui restano solo host, porta e nome del
 * database, le informazioni utili a capire dove il servizio sta puntando.
 */

/** Fallback costante: non deve mai rimandare l'input, che può contenere segreti. */
export const INVALID_DATABASE_TARGET = 'host-non-valido';

/**
 * `postgres://wallos_user:segreto@192.168.0.59:5432/wallos?sslmode=disable`
 *   → `192.168.0.59:5432/wallos`
 *
 * La URL viene ricostruita da zero con i soli campi sicuri: userinfo e query
 * string (che può veicolare token o opzioni sensibili) non vengono mai
 * interpolati. Se la stringa non è parsabile si restituisce una costante, mai
 * l'originale.
 */
export function sanitizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    if (!host) return INVALID_DATABASE_TARGET;

    const port = parsed.port || '5432';
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) || '?';
    return `${host}:${port}/${database}`;
  } catch {
    return INVALID_DATABASE_TARGET;
  }
}

export interface StartupLogInput {
  host: string;
  port: number;
  databaseUrl: string;
}

/**
 * Riga di bootstrap del servizio: endpoint HTTP e destinazione PostgreSQL.
 * L'URL completa non viene mai interpolata, nemmeno per errore.
 */
export function formatStartupMessage(target: StartupLogInput): string {
  return `auth pronta · http://${target.host}:${target.port} · db ${sanitizeDatabaseUrl(target.databaseUrl)}`;
}
