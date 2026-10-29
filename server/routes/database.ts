import type { FastifyInstance } from 'fastify';

import type { Database } from '../db.js';
import { requireAuth } from '../session.js';
import type { AuthConfig } from '../types.js';

interface DatabaseRoutesDeps {
  db: Database;
  config: AuthConfig;
}

/** Quanti controlli restituire quando il client non chiede un limite. */
const DEFAULT_HISTORY_LIMIT = 50;
/** Tetto alla risposta: 100 righe bastano alla diagnostica e al pannello touch. */
const MAX_HISTORY_LIMIT = 100;

interface HealthCheckRow {
  id: string | number;
  status: string;
  latencyMs: number | string;
  checkedAt: Date | string;
  errorMessage: string | null;
}

interface HealthCheckDto {
  id: string;
  status: string;
  latencyMs: number;
  checkedAt: string;
  errorMessage: string | null;
}

/**
 * `?limit=` arriva come stringa (o come array se ripetuto). Un valore non
 * numerico ricade sul default invece di far fallire la diagnostica; il limite
 * viene comunque limitato a 100, così una query non può chiedere l'intera
 * tabella.
 */
export function parseHistoryLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(parsed, MAX_HISTORY_LIMIT);
}

function toDto(row: HealthCheckRow): HealthCheckDto {
  const checkedAt =
    row.checkedAt instanceof Date ? row.checkedAt.toISOString() : String(row.checkedAt);

  return {
    id: String(row.id),
    status: row.status,
    latencyMs: Number(row.latencyMs),
    checkedAt,
    errorMessage: row.errorMessage,
  };
}

/**
 * GET /api/database/history
 *
 * Storico dei controlli di connettività scritti da `logDatabaseCheck()`.
 * Risponde con un array ordinato dal più recente e include latenza ed errore,
 * così il pannello può mostrare stato, timestamp e causa di un down.
 *
 * Richiede una sessione: l'audit del database non è un endpoint pubblico come
 * `/api/health`. Se il database è irraggiungibile la risposta è 500 con un
 * codice stabile: il client mantiene l'ultimo storico in cache e mostra
 * l'avviso di disconnessione.
 */
export function registerDatabaseRoutes(app: FastifyInstance, deps: DatabaseRoutesDeps): void {
  app.get(
    '/api/database/history',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const limit = parseHistoryLimit((request.query as { limit?: unknown } | undefined)?.limit);

      try {
        const { rows } = await deps.db.client.query<HealthCheckRow>(
          `SELECT
             id,
             status,
             latency_ms AS "latencyMs",
             checked_at AS "checkedAt",
             error_message AS "errorMessage"
           FROM db_health_checks
           ORDER BY checked_at DESC, id DESC
           LIMIT $1`,
          [limit],
        );

        return reply.send(rows.map(toDto));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        request.log.error({ err: error }, 'storico health check non disponibile');
        return reply.code(500).send({
          error: 'DB_HISTORY_UNAVAILABLE',
          message: 'Errore nel recupero dello storico DB',
          // Codice del driver (ECONNREFUSED, 57P01…): nessun host o password.
          cause: message.slice(0, 200),
        });
      }
    },
  );
}
