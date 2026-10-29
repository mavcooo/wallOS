import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Database } from '../db.js';
import { HttpError } from '../http.js';
import { verifySecret } from '../security.js';
import { assertNotLocked, requireAuth, requireRole } from '../session.js';
import type { SecurityEventBus } from '../services/securityEvents.js';
import type { AlarmManager } from '../services/alarmManager.js';
import {
  acknowledgeSecurityEvent,
  armSystem,
  decodeHistoryCursor,
  disarmSystem,
  readActiveEvents,
  readSecurityHistory,
  readSecuritySnapshot,
  readSecurityState,
  readSecurityZones,
  moveSensorToZone,
  resolveSecurityEvent,
  updateSecurityZone,
  type ArmBlocker,
  type SecuritySeverity,
} from '../services/securityStore.js';
import type { AuthConfig } from '../types.js';

export interface SecurityRouteDeps {
  db: Database;
  config: AuthConfig;
  /** Bus real-time: il worker MQTT vi inoltra gli allarmi, le rotte le azioni. */
  events: SecurityEventBus;
  /**
   * Worker: serve per gli allarmi bloccanti (contatti aperti) e per far
   * rileggere subito zone e sensori dopo una modifica di configurazione.
   */
  alarmManager?: Pick<AlarmManager, 'openSensors' | 'refreshSensors'>;
}

/** Un PIN valido resta valido per la richiesta corrente; l'elevazione dura. */
const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, 'Il PIN deve contenere da 4 a 6 cifre');

const armSchema = z.object({
  mode: z.enum(['ARMED_HOME', 'ARMED_AWAY']),
  /** Obbligatorio quando la sessione non è già elevata da `/api/auth/verify-pin`. */
  pin: pinSchema.optional(),
});

const pinOnlySchema = z.object({
  pin: pinSchema.optional(),
});

const eventParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, 'id evento non valido'),
});

/** Slug di zona e device: stesso alfabeto di `rooms`/`devices` e dei topic MQTT. */
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/, 'Identificativo non valido');

const zoneParamsSchema = z.object({ id: slugSchema });
const sensorParamsSchema = z.object({ deviceId: slugSchema });

const zonePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    armHome: z.boolean().optional(),
    armAway: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Serve almeno un campo da aggiornare');

const sensorZoneSchema = z.object({ zoneId: slugSchema });

const resolveSchema = z.object({
  pin: pinSchema.optional(),
  notes: z.string().trim().max(500).optional(),
});

/** Tetto dello storico: un export non deve poter chiedere tutta la tabella. */
export const MAX_SECURITY_HISTORY = 200;
const DEFAULT_SECURITY_HISTORY = 50;

const historyQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  limit: z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return DEFAULT_SECURITY_HISTORY;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : value;
  }, z.number().int().min(1).max(MAX_SECURITY_HISTORY)),
  cursor: z.string().trim().min(1).max(256).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
});

function parseTimestamp(value: string | undefined, field: string): Date | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'INVALID_QUERY', `${field} deve essere una data ISO 8601`);
  }
  return new Date(parsed);
}

interface Authorised {
  userId: string;
}

/**
 * Autorizzazione delle azioni di sicurezza.
 *
 * Il PIN è la credenziale forte: un profilo `guest` non può mai armare o
 * disarmare, e un `kiosk` deve dimostrare di conoscere il PIN (la sola sessione
 * del tablet, se rubato, non basta a togliere l'antifurto). La verifica usa gli
 * stessi contatori di `/api/auth/verify-pin`, quindi un attacco di forza bruta
 * sulla rotta di sicurezza consuma lo stesso lockout.
 */
async function authorize(
  request: FastifyRequest,
  deps: SecurityRouteDeps,
  pin: string | undefined,
): Promise<Authorised> {
  const auth = request.auth;
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessione assente');
  if (auth.user.role === 'guest') {
    throw new HttpError(403, 'FORBIDDEN', 'Il profilo ospite non gestisce l’impianto');
  }
  if (auth.elevated) return { userId: auth.user.id };

  if (!pin) {
    throw new HttpError(
      403,
      'ELEVATION_REQUIRED',
      'Verifica il PIN di sicurezza per questa operazione',
    );
  }

  const attemptKey = `pin:${auth.user.id}`;
  await assertNotLocked(deps.db, attemptKey, 'PIN_LOCKED');

  const valid = await verifySecret(pin, auth.user.pin_hash);
  if (!valid) {
    const failure = await deps.db.recordFailure(attemptKey, deps.config.pinPolicy);
    throw new HttpError(
      401,
      'INVALID_PIN',
      'PIN di sicurezza non valido',
      failure.lockedUntil > 0
        ? { retryAfterMs: failure.lockedUntil - Date.now(), remainingAttempts: 0 }
        : {
            remainingAttempts: Math.max(0, deps.config.pinPolicy.maxAttempts - failure.failures),
          },
    );
  }

  await deps.db.clearFailures(attemptKey);
  return { userId: auth.user.id };
}

/** Eventi aperti + sensori aperti: motivi per cui `arm` risponde 409. */
async function collectBlockers(deps: SecurityRouteDeps): Promise<ArmBlocker[]> {
  const blockers: ArmBlocker[] = [];
  const seen = new Set<string>();

  for (const event of await readActiveEvents(deps.db)) {
    const key = `alarm:${event.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push({
      kind: 'active_alarm',
      deviceId: event.deviceId,
      label: `${event.deviceName} · ${event.eventType}`,
    });
  }

  for (const sensor of deps.alarmManager?.openSensors() ?? []) {
    const key = `open:${sensor.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push({
      kind: 'open_sensor',
      deviceId: sensor.deviceId,
      label: `${sensor.name}${sensor.roomName ? ` · ${sensor.roomName}` : ''}`,
    });
  }

  return blockers;
}

async function snapshotResponse(deps: SecurityRouteDeps) {
  const snapshot = await readSecuritySnapshot(deps.db);
  return {
    ...snapshot,
    openSensors: deps.alarmManager?.openSensors() ?? [],
  };
}

/** Commento SSE periodico: tiene viva la connessione dietro i proxy domestici. */
const HEARTBEAT_MS = 25_000;

/**
 * Rotte del sistema di allarme.
 *
 * - `GET /state` è l'idratazione: stato, zone e **allarmi ancora aperti**. È la
 *   chiamata che il tablet fa al boot, quindi un evento scattato mentre nessuno
 *   guardava ricompare sullo schermo senza fare affidamento su un toast;
 * - `arm`/`disarm` richiedono PIN o sessione elevata e persistono su
 *   `security_system_state`; `arm` rifiuta con 409 se c'è un allarme aperto o
 *   un contatto aperto;
 * - `ack` timbra l'evento senza chiuderlo, `resolve` lo chiude; nessuno dei due
 *   cancella la riga;
 * - `stream` è il canale SSE che invalida la query del pannello appena lo stato
 *   cambia (allarme, armamento, acknowledgment).
 */
export function registerSecurityRoutes(app: FastifyInstance, deps: SecurityRouteDeps): void {
  const preHandler = requireAuth(deps);

  app.get('/api/security/state', { preHandler }, async (_request, reply) => {
    return reply.send(await snapshotResponse(deps));
  });

  app.post('/api/security/arm', { preHandler }, async (request, reply) => {
    const parsed = armSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_BODY', 'Modalità di armamento non valida');
    }

    const { mode, pin } = parsed.data;
    const actor = await authorize(request, deps, pin);

    const blockers = await collectBlockers(deps);
    if (blockers.length > 0) {
      throw new HttpError(
        409,
        'ZONE_NOT_READY',
        'Impossibile armare: allarmi aperti o sensori non in riposo',
        { blocking: blockers },
      );
    }

    const state = await armSystem(deps.db, { mode, userId: actor.userId });
    deps.events.publish({
      type: 'armed',
      at: new Date().toISOString(),
      status: state.status,
      activeCount: 0,
    });

    return reply.send(await snapshotResponse(deps));
  });

  app.post('/api/security/disarm', { preHandler }, async (request, reply) => {
    const parsed = pinOnlySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_BODY', 'Corpo della richiesta non valido');
    }

    const actor = await authorize(request, deps, parsed.data.pin);
    const state = await disarmSystem(deps.db, actor.userId);
    deps.events.publish({
      type: 'disarmed',
      at: new Date().toISOString(),
      status: state.status,
      activeCount: (await readActiveEvents(deps.db)).length,
    });

    return reply.send(await snapshotResponse(deps));
  });

  app.post('/api/security/events/:id/ack', { preHandler }, async (request, reply) => {
    const params = eventParamsSchema.safeParse(request.params);
    if (!params.success) throw new HttpError(400, 'INVALID_BODY', 'id evento non valido');

    const parsed = pinOnlySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'INVALID_BODY', 'Corpo della richiesta non valido');

    const actor = await authorize(request, deps, parsed.data.pin);
    const result = await acknowledgeSecurityEvent(deps.db, params.data.id, actor.userId);

    if (result.status === 'not_found') {
      throw new HttpError(404, 'EVENT_NOT_FOUND', 'Evento non trovato');
    }
    if (result.status === 'already_resolved') {
      throw new HttpError(409, 'EVENT_RESOLVED', 'L’evento è già stato risolto');
    }

    // `already_acknowledged` è idempotente: il pannello può inviare l'ACK due
    // volte (doppio tap sul tablet) senza vedere un errore.
    if (result.status === 'updated') {
      deps.events.publish({
        type: 'acknowledged',
        at: new Date().toISOString(),
        status: (await readSecurityState(deps.db)).status,
        activeCount: (await readActiveEvents(deps.db)).length,
        eventId: params.data.id,
        ...(result.event ? { deviceId: result.event.deviceId, eventType: result.event.eventType } : {}),
      });
    }

    return reply.send({ event: result.event });
  });

  app.post('/api/security/events/:id/resolve', { preHandler }, async (request, reply) => {
    const params = eventParamsSchema.safeParse(request.params);
    if (!params.success) throw new HttpError(400, 'INVALID_BODY', 'id evento non valido');

    const parsed = resolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_BODY', 'Note non valide (massimo 500 caratteri)');
    }

    const actor = await authorize(request, deps, parsed.data.pin);
    const result = await resolveSecurityEvent(
      deps.db,
      params.data.id,
      actor.userId,
      parsed.data.notes ?? null,
    );

    if (result.status === 'not_found') {
      throw new HttpError(404, 'EVENT_NOT_FOUND', 'Evento non trovato');
    }
    if (result.status === 'already_resolved') {
      throw new HttpError(409, 'EVENT_RESOLVED', 'L’evento è già stato risolto');
    }

    const state = await readSecurityState(deps.db);
    deps.events.publish({
      type: 'resolved',
      at: new Date().toISOString(),
      status: state.status,
      activeCount: (await readActiveEvents(deps.db)).length,
      eventId: params.data.id,
    });

    return reply.send({ event: result.event, state });
  });

  app.get('/api/security/history', { preHandler }, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_QUERY', 'Parametri dello storico non validi');
    }

    const { from, to, limit, cursor, severity } = parsed.data;
    const parsedCursor = cursor === undefined ? null : decodeHistoryCursor(cursor);
    if (cursor !== undefined && parsedCursor === null) {
      throw new HttpError(400, 'INVALID_QUERY', 'cursor non valido');
    }

    const page = await readSecurityHistory(deps.db, {
      from: parseTimestamp(from, 'from'),
      to: parseTimestamp(to, 'to'),
      limit,
      cursor: parsedCursor,
      severity: (severity ?? null) as SecuritySeverity | null,
    });

    return reply.send(page);
  });

  // ── Configurazione zone (solo amministratore) ────────────────────────────
  // Sono parametri d'impianto, non azioni operative: cambiarli richiede lo
  // stesso privilegio della topologia, non il solo PIN. Dopo il commit il
  // worker rilegge le mappature, così il nuovo perimetro vale dal messaggio
  // successivo senza riavviare nulla.
  const adminOnly = requireRole(deps, ['admin']);

  app.patch('/api/security/zones/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = zoneParamsSchema.safeParse(request.params);
    if (!params.success) throw new HttpError(400, 'INVALID_BODY', 'id zona non valido');

    const parsed = zonePatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_BODY', 'Configurazione zona non valida', {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }

    const zone = await updateSecurityZone(deps.db, params.data.id, parsed.data);
    if (!zone) throw new HttpError(404, 'ZONE_NOT_FOUND', 'Zona non trovata');

    await deps.alarmManager?.refreshSensors();
    return reply.send({ zone, zones: await readSecurityZones(deps.db) });
  });

  app.patch('/api/security/sensors/:deviceId', { preHandler: adminOnly }, async (request, reply) => {
    const params = sensorParamsSchema.safeParse(request.params);
    if (!params.success) throw new HttpError(400, 'INVALID_BODY', 'deviceId non valido');

    const parsed = sensorZoneSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'INVALID_BODY', 'zoneId obbligatorio');

    const moved = await moveSensorToZone(deps.db, params.data.deviceId, parsed.data.zoneId);
    if (!moved) {
      throw new HttpError(
        404,
        'SENSOR_NOT_MAPPED',
        'Sensore non associato a una zona o zona inesistente',
      );
    }

    await deps.alarmManager?.refreshSensors();
    return reply.send({ zones: await readSecurityZones(deps.db) });
  });

  const clients = new Set<() => void>();

  app.get('/api/security/stream', { preHandler }, (_request, reply) => {
    const raw = reply.raw;
    // Fastify non gestisce questa risposta: il flusso resta aperto.
    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 3000\n\n');

    const unsubscribe = deps.events.subscribe((event) => {
      write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);

    function write(chunk: string): void {
      if (!clients.has(dispose)) return;
      try {
        raw.write(chunk);
      } catch {
        dispose();
      }
    }

    function dispose(): void {
      if (!clients.delete(dispose)) return;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        raw.end();
      } catch {
        /* socket già chiusa */
      }
    }

    clients.add(dispose);
    raw.on('close', dispose);
  });

  app.addHook('onClose', async () => {
    for (const dispose of [...clients]) dispose();
  });
}
