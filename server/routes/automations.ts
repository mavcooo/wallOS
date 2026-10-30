import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Database } from '../db.js';
import { timestampMs } from '../db.js';
import { HttpError } from '../http.js';
import { requireAuth, requireRole } from '../session.js';
import { isValidCron } from '../services/cron.js';
import {
  DEFAULT_AUTOMATION_THROTTLE_MS,
  describeAutomation,
  MAX_AUTOMATION_THROTTLE_MS,
  resolveAutomation,
  type AutomationRunResult,
} from '../services/automationEngine.js';
import type {
  AuthConfig,
  AutomationAction,
  AutomationCondition,
  AutomationRow,
  AutomationWithLastLogRow,
  DeviceAutomationActivity,
} from '../types.js';

interface AutomationDeps {
  db: Database;
  config: AuthConfig;
  /** Runtime del motore: ricarica la cache e consente il test manuale. */
  automations: AutomationRuntime;
}

export interface AutomationRuntime {
  reload(): Promise<unknown>;
  runTest(id: string): Promise<AutomationRunResult>;
  /** Ultimi comandi inviati per device (in memoria nel processo del motore). */
  activity(): DeviceAutomationActivity[];
}

const MAX_CONDITIONS = 20;
/** Gruppi in OR oltre al primo (`conditions`): un elenco più lungo è illeggibile. */
const MAX_CONDITION_GROUPS = 8;
const MAX_ACTIONS = 20;

/**
 * Topic di pubblicazione: niente spazi né wildcard — `+` e `#` in un comando
 * sono quasi sempre un errore di copia-incolla dal topic di stato.
 */
const publishTopicSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\s#+]/.test(value), {
    message: 'Il topic di comando non può contenere spazi, "+" o "#"',
  });

/** Topic di ascolto: le wildcard MQTT sono ammesse, `#` solo in coda. */
const subscriptionTopicSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/\s/.test(value) && (!value.includes('#') || value.endsWith('#')), {
    message: 'Il topic di ascolto non può contenere spazi e "#" deve stare in fondo',
  });

/** `HH:MM` (accetta anche `H:MM` e i secondi, che vengono scartati). */
const clockSchema = z
  .string()
  .trim()
  .regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'Orario atteso nel formato HH:MM')
  .refine(
    (value) => {
      const [hours = '0', minutes = '0'] = value.split(':');
      return Number(hours) <= 23 && Number(minutes) <= 59;
    },
    { message: 'Orario non valido: ore 00-23, minuti 00-59' },
  )
  .transform((value) => {
    const [hours = '0', minutes = '0'] = value.split(':');
    return `${hours.padStart(2, '0')}:${minutes}`;
  });

const triggerConfigSchema = z.discriminatedUnion('triggerType', [
  z.object({
    triggerType: z.literal('mqtt_state'),
    triggerConfig: z
      .object({
        topic: subscriptionTopicSchema,
        payloadKey: z.string().trim().min(1).max(64).optional(),
        expectedValue: z.union([z.string().max(256), z.number(), z.boolean()]).optional(),
      })
      .strict(),
  }),
  z.object({
    triggerType: z.literal('time_cron'),
    triggerConfig: z
      .object({
        cron: z
          .string()
          .trim()
          .max(128)
          .refine(isValidCron, {
            message:
              'Espressione cron non valida: 5 campi (minuto ora giorno mese giorno-settimana)',
          }),
      })
      .strict(),
  }),
  z.object({
    triggerType: z.literal('sun_event'),
    triggerConfig: z
      .object({
        event: z.enum(['sunrise', 'sunset']),
        offsetMinutes: z.number().int().min(-720).max(720).default(0),
      })
      .strict(),
  }),
]);

const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('time_range'), start: clockSchema, end: clockSchema }).strict(),
  z
    .object({
      type: z.literal('device_state'),
      deviceId: z.string().trim().min(1).max(64),
      expectedState: z.string().trim().min(1).max(64),
    })
    .strict(),
  z.object({ type: z.literal('user_present'), requireHome: z.boolean() }).strict(),
]);

const delaySchema = z.number().int().min(0).max(60 * 60_000).default(0);

const mqttActionSchema = z
  .object({
    // Il default copre le regole scritte prima della migrazione 005, dove
    // `type` non esisteva: `{ topic, payload }` resta un comando MQTT valido.
    type: z.literal('mqtt').default('mqtt'),
    topic: publishTopicSchema,
    payload: z
      .union([z.string().max(4096), z.number(), z.boolean()])
      .transform((value) => (typeof value === 'string' ? value : String(value))),
    delayMs: delaySchema,
  })
  .strict();

const scenarioActionSchema = z
  .object({
    type: z.literal('scenario'),
    scenarioId: z.string().trim().min(1).max(64),
    delayMs: delaySchema,
  })
  .strict();

/** Azione: comando MQTT diretto oppure scenario salvato in `scenarios`. */
const actionSchema = z.union([mqttActionSchema, scenarioActionSchema]);

/**
 * Gruppo di condizioni: array non vuoto (AND fra le sue condizioni, OR fra i gruppi).
 */
const conditionGroupSchema = z.array(conditionSchema).min(1).max(MAX_CONDITIONS);

const ruleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(2000).nullish(),
    isActive: z.boolean().default(true),
    /**
     * Cooldown fra due esecuzioni della stessa regola: il valore che sopprime
     * i burst di messaggi MQTT concorrenti. `0` lo disabilita, oltre il tetto
     * del motore il comando arriverebbe quando non serve più.
     */
    throttleMs: z
      .number()
      .int('throttleMs deve essere un numero intero di millisecondi')
      .min(0, 'throttleMs non può essere negativo')
      .max(
        MAX_AUTOMATION_THROTTLE_MS,
        `throttleMs non può superare ${MAX_AUTOMATION_THROTTLE_MS} ms (10 minuti)`,
      )
      .default(DEFAULT_AUTOMATION_THROTTLE_MS),
    /** Primo gruppo di condizioni. */
    conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
    /** Altri gruppi, in OR con il primo e fra loro. */
    conditionGroups: z.array(conditionGroupSchema).max(MAX_CONDITION_GROUPS).default([]),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  })
  .and(triggerConfigSchema);

const idSchema = z.string().uuid();

// ── DTO ─────────────────────────────────────────────────────────────────────

interface AutomationRunDto {
  at: number;
  triggerSource: string;
  conditionsMet: boolean;
  executionTimeMs: number;
  error: string | null;
  actions: unknown;
}

interface AutomationDto {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  triggerType: string;
  triggerConfig: unknown;
  conditions: AutomationCondition[];
  conditionGroups: AutomationCondition[][];
  actions: unknown;
  /** Finestra di deduplicazione effettiva applicata dal motore, in ms. */
  throttleMs: number;
  lastTriggeredAt: number | null;
  executionCount: number;
  createdAt: number;
  updatedAt: number;
  /** Ultima esecuzione registrata: alimenta il badge di stato del pannello. */
  lastRun: AutomationRunDto | null;
  /** Motivo per cui la regola non può essere eseguita (`null` = eseguibile). */
  invalidReason: string | null;
  /** Sommario leggibile del trigger, calcolato dal motore. */
  summary: string;
}

/** Righe di `listAutomations` portano l'esito dell'ultima esecuzione. */
function toDto(row: AutomationRow | AutomationWithLastLogRow, config: AuthConfig): AutomationDto {
  const resolved = resolveAutomation(row, config.automation);
  const withLog = row as Partial<AutomationWithLastLogRow>;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config,
    conditions: resolved.conditions,
    conditionGroups: resolved.conditionGroups,
    actions: resolved.actions,
    throttleMs: resolved.throttleMs,
    lastTriggeredAt:
      row.last_triggered_at === null ? null : timestampMs(row.last_triggered_at) || null,
    executionCount: Number(row.execution_count),
    createdAt: timestampMs(row.created_at),
    updatedAt: timestampMs(row.updated_at),
    lastRun:
      withLog.last_log_at === null || withLog.last_log_at === undefined
        ? null
        : {
            at: timestampMs(withLog.last_log_at),
            triggerSource: 'log',
            conditionsMet: withLog.last_log_conditions_met ?? false,
            executionTimeMs: Number(withLog.last_log_execution_time_ms ?? 0),
            error: withLog.last_log_error ?? null,
            actions: null,
          },
    invalidReason: resolved.invalidReason,
    summary: describeAutomation(resolved),
  };
}

/** Validazione Zod → 400 con il campo colpevole, come le altre route. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, 'INVALID_BODY', issue?.message ?? 'Automazione non valida', {
      field: issue?.path.join('.') ?? 'automation',
    });
  }
  return parsed.data;
}

async function loadRule(db: Database, id: string): Promise<AutomationRow> {
  if (!idSchema.safeParse(id).success) {
    throw new HttpError(404, 'AUTOMATION_NOT_FOUND', 'Automazione non trovata');
  }
  const row = await db.findAutomationById(id);
  if (!row) throw new HttpError(404, 'AUTOMATION_NOT_FOUND', 'Automazione non trovata');
  return row;
}

/**
 * Un'azione di scenario che punta a uno scenario inesistente non entra nel
 * database: altrimenti l'errore si vedrebbe solo nel log, a regola scattata.
 */
async function assertScenariosExist(db: Database, actions: AutomationAction[]): Promise<void> {
  const ids = [
    ...new Set(
      actions.filter((action) => action.type === 'scenario').map((action) => action.scenarioId),
    ),
  ];
  for (const id of ids) {
    if (!(await db.findScenarioById(id))) {
      throw new HttpError(400, 'SCENARIO_NOT_FOUND', `Scenario "${id}" non trovato`, {
        field: 'actions',
      });
    }
  }
}

/**
 * Motore di automazioni.
 *
 * - lettura della lista e dello storico: qualsiasi sessione autenticata (il
 *   pannello kiosk mostra lo stato delle regole);
 * - creazione, modifica, attivazione/disattivazione, test ed eliminazione:
 *   solo `admin`. Una regola attiva pubblica comandi sul broker, quindi non è
 *   una modifica alla portata di un ospite.
 *
 * Le route scrivono su PostgreSQL e chiedono al motore di ricaricare la cache:
 * è il motore, non la HTTP request, a parlare con il broker.
 */
export function registerAutomationRoutes(app: FastifyInstance, deps: AutomationDeps): void {
  app.get('/api/automations', { preHandler: requireAuth(deps) }, async () => {
    const rows = await deps.db.listAutomations();
    return { automations: rows.map((row) => toDto(row, deps.config)) };
  });

  /**
   * Ultimo comando inviato a ciascun dispositivo: risponde alla domanda "quale
   * automazione ha comandato questa luce?". Vive in memoria nel motore (un
   * riavvio lo azzera) mentre la cronologia persistente resta `automation_logs`.
   */
  app.get('/api/automations/activity', { preHandler: requireAuth(deps) }, async () => ({
    activity: deps.automations.activity(),
  }));

  app.post(
    '/api/automations',
    { preHandler: requireRole(deps, ['admin']) },
    async (request, reply) => {
      const body = parseBody(ruleBodySchema, request.body);
      await assertScenariosExist(deps.db, body.actions);
      const created = await deps.db.createAutomation({
        name: body.name,
        description: body.description ?? null,
        isActive: body.isActive,
        triggerType: body.triggerType,
        triggerConfig: body.triggerConfig,
        conditions: body.conditions,
        conditionGroups: body.conditionGroups,
        actions: body.actions,
        throttleMs: body.throttleMs,
      });
      if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Automazione non creata');

      await deps.automations.reload();
      return reply.code(201).send({ automation: toDto(created, deps.config) });
    },
  );

  app.put(
    '/api/automations/:id',
    { preHandler: requireRole(deps, ['admin']) },
    async (request) => {
      const { id } = request.params as { id: string };
      await loadRule(deps.db, id);
      const body = parseBody(ruleBodySchema, request.body);
      await assertScenariosExist(deps.db, body.actions);

      const updated = await deps.db.updateAutomation(id, {
        name: body.name,
        description: body.description ?? null,
        isActive: body.isActive,
        triggerType: body.triggerType,
        triggerConfig: body.triggerConfig,
        conditions: body.conditions,
        conditionGroups: body.conditionGroups,
        actions: body.actions,
        throttleMs: body.throttleMs,
      });
      if (!updated) throw new HttpError(404, 'AUTOMATION_NOT_FOUND', 'Automazione non trovata');

      await deps.automations.reload();
      return { automation: toDto(updated, deps.config) };
    },
  );

  app.patch(
    '/api/automations/:id/toggle',
    { preHandler: requireRole(deps, ['admin']) },
    async (request) => {
      const { id } = request.params as { id: string };
      const rule = await loadRule(deps.db, id);

      const body = (request.body ?? {}) as { isActive?: unknown };
      const isActive = typeof body.isActive === 'boolean' ? body.isActive : !rule.is_active;

      const updated = await deps.db.setAutomationActive(id, isActive);
      if (!updated) throw new HttpError(404, 'AUTOMATION_NOT_FOUND', 'Automazione non trovata');

      await deps.automations.reload();
      return { automation: toDto(updated, deps.config) };
    },
  );

  app.post(
    '/api/automations/:id/test',
    { preHandler: requireRole(deps, ['admin']) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await loadRule(deps.db, id);
      const result = await deps.automations.runTest(id);

      return reply.code(201).send({
        execution: {
          automationId: result.automationId,
          triggerSource: result.triggerSource,
          conditionsMet: result.conditionsMet,
          executionTimeMs: result.executionTimeMs,
          error: result.error,
          actions: result.actions,
        },
      });
    },
  );

  app.get('/api/automations/:id/logs', { preHandler: requireAuth(deps) }, async (request) => {
    const { id } = request.params as { id: string };
    await loadRule(deps.db, id);

    const query = request.query as Record<string, unknown>;
    const requested = Number(query['limit']);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 50) : 10;
    const logs = await deps.db.listAutomationLogs(id, limit);
    return {
      automationId: id,
      logs: logs.map((row) => ({
        id: String(row.id),
        triggeredAt: timestampMs(row.triggered_at),
        triggerSource: row.trigger_source,
        conditionsMet: row.conditions_met,
        executionTimeMs: Number(row.execution_time_ms),
        error: row.error_message,
        actions: row.actions_executed,
      })),
    };
  });

  app.delete(
    '/api/automations/:id',
    { preHandler: requireRole(deps, ['admin']) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await loadRule(deps.db, id);
      await deps.db.deleteAutomation(id);
      await deps.automations.reload();
      return reply.code(204).send();
    },
  );
}
