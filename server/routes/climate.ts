import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ClimateScheduleInput, Database } from '../db.js';
import { timestampMs } from '../db.js';
import { HttpError } from '../http.js';
import { requireAuth, requireRole } from '../session.js';
import {
  activeWindowEnd,
  isOverrideActive,
  isVacationActive,
  MANUAL_PRESET,
  minutesOfTime,
  nextWindowStart,
  normalizeWindows,
  resolveActiveWindow,
  timeOfMinutes,
} from '../services/climateScheduler.js';
import type {
  AuthConfig,
  ClimatePreset,
  ClimateRuntimeRow,
  ClimateScheduleRow,
  DeviceRow,
} from '../types.js';

interface ClimateDeps {
  db: Database;
  config: AuthConfig;
}

/** Preset del cronotermostato: etichette di programma, non modalità firmware. */
const CLIMATE_PRESETS = ['comfort', 'eco', 'auto', 'off'] as const satisfies readonly ClimatePreset[];

const DEVICE_ID_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/**
 * `HH:MM`, `HH:MM:SS` o `24:00` → stringa `TIME` normalizzata.
 * `24:00` è l'unico modo per chiudere una fascia a fine giornata.
 */
function normalizeTime(value: string, field: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    throw new HttpError(400, 'INVALID_BODY', `${field} deve essere un orario HH:MM`, { field });
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  const isEndOfDay = hours === 24 && minutes === 0 && seconds === 0;
  if (!isEndOfDay && (hours > 23 || minutes > 59 || seconds > 59)) {
    throw new HttpError(400, 'INVALID_BODY', `${field} non è un orario valido`, { field });
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** `HH:MM:SS` (o `24:00:00`) → `HH:MM`, il formato che usa il pannello. */
function shortTime(value: string): string {
  return timeOfMinutes(minutesOfTime(value));
}

const scheduleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().min(4).max(8),
  endTime: z.string().min(4).max(8),
  targetTemp: z.number().min(5).max(30),
  preset: z.enum(CLIMATE_PRESETS).default('auto'),
  isActive: z.boolean().default(true),
});

const schedulesBodySchema = z.object({
  schedules: z.array(scheduleSchema).max(7 * 12),
});

const overrideBodySchema = z
  .object({
    targetTemp: z.number().min(5).max(30),
    preset: z.enum(CLIMATE_PRESETS).optional(),
    durationMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    until: z
      .union([
        z.literal('next_schedule'),
        z.literal('permanent'),
        z.string().datetime({ offset: true }),
      ])
      .optional(),
  })
  .strict();

const vacationBodySchema = z
  .object({
    active: z.boolean().default(true),
    until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

interface ScheduleDto {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  targetTemp: number;
  preset: ClimatePreset;
  isActive: boolean;
}

function toScheduleDto(row: ClimateScheduleRow): ScheduleDto {
  return {
    id: row.id,
    dayOfWeek: Number(row.day_of_week),
    startTime: shortTime(row.start_time),
    endTime: shortTime(row.end_time),
    targetTemp: Number(row.target_temp),
    preset: (row.hvac_mode as ClimatePreset) ?? 'auto',
    isActive: row.is_active,
  };
}

interface RuntimeDto {
  override: {
    targetTemp: number;
    preset: ClimatePreset;
    /** Epoch ms; `null` = permanente finché non viene annullato. */
    until: number | null;
    permanent: boolean;
  } | null;
  vacation: {
    /** Epoch ms; `null` = vacanza senza data di rientro. */
    until: number | null;
    permanent: boolean;
  } | null;
  lastSent: { targetTemp: number | null; preset: ClimatePreset; at: number } | null;
}

function toRuntimeDto(runtime: ClimateRuntimeRow, at = new Date()): RuntimeDto {
  const overrideActive = isOverrideActive(runtime, at);
  const vacationActive = isVacationActive(runtime, at);
  const lastSentAt = timestampMs(runtime.last_sent_at);

  return {
    override: overrideActive
      ? {
          targetTemp: Number(runtime.override_target_temp),
          preset: (runtime.override_hvac_mode as ClimatePreset | null) ?? MANUAL_PRESET,
          until: runtime.override_until === null ? null : timestampMs(runtime.override_until),
          permanent: runtime.override_until === null,
        }
      : null,
    vacation: vacationActive
      ? {
          until: runtime.vacation_until === null ? null : timestampMs(runtime.vacation_until),
          permanent: runtime.vacation_until === null,
        }
      : null,
    lastSent:
      lastSentAt > 0 && runtime.last_sent_hvac_mode !== null
        ? {
            targetTemp:
              runtime.last_sent_target_temp === null
                ? null
                : Number(runtime.last_sent_target_temp),
            preset: runtime.last_sent_hvac_mode as ClimatePreset,
            at: lastSentAt,
          }
        : null,
  };
}

/** 404 se l'id non esiste *o* non è un cronotermostato. */
async function loadClimateDevice(db: Database, deviceId: string): Promise<DeviceRow> {
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Dispositivo non trovato');
  }
  const device = await db.findDeviceById(deviceId);
  if (!device || device.type !== 'climate') {
    throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Cronotermostato non trovato');
  }
  return device;
}

/**
 * Fasce validate: nessuna sovrapposizione nello stesso giorno e nessun
 * intervallo vuoto. Il salvataggio sostituisce l'intera settimana, quindi un
 * errore qui non può lasciare metà programma.
 */
function validateSchedules(schedules: readonly z.infer<typeof scheduleSchema>[]): ClimateScheduleInput[] {
  const normalized: ClimateScheduleInput[] = schedules.map((schedule) => {
    const startTime = normalizeTime(schedule.startTime, 'startTime');
    const endTime = normalizeTime(schedule.endTime, 'endTime');
    if (minutesOfTime(startTime) >= minutesOfTime(endTime)) {
      throw new HttpError(
        400,
        'INVALID_BODY',
        'La fine di una fascia deve essere successiva all’inizio (le fasce non scavalcano la mezzanotte)',
        { field: 'endTime' },
      );
    }
    return {
      dayOfWeek: schedule.dayOfWeek,
      startTime,
      endTime,
      targetTemp: Math.round(schedule.targetTemp * 10) / 10,
      preset: schedule.preset,
      isActive: schedule.isActive,
    };
  });

  for (let day = 0; day <= 6; day += 1) {
    const windows = normalized
      .filter((schedule) => schedule.dayOfWeek === day && schedule.isActive)
      .sort((left, right) => minutesOfTime(left.startTime) - minutesOfTime(right.startTime));
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1];
      const current = windows[index];
      if (previous && current && minutesOfTime(current.startTime) < minutesOfTime(previous.endTime)) {
        throw new HttpError(
          400,
          'INVALID_BODY',
          `Fasce sovrapposte nello stesso giorno (${shortTime(previous.startTime)}–${shortTime(previous.endTime)} e ${shortTime(current.startTime)}–${shortTime(current.endTime)})`,
          { field: 'schedules' },
        );
      }
    }
  }

  return normalized;
}

/**
 * Cronotermostato settimanale.
 *
 * - lettura e override manuale: qualsiasi sessione autenticata;
 * - modifica del programma e vacanza: `admin`, `family` e `kiosk` — il pannello
 *   a parete *è* un utente kiosk, e il programma si imposta proprio da lì;
 *   l'ospite (`guest`) resta in sola lettura.
 *
 * Le route scrivono solo su PostgreSQL: la pubblicazione MQTT è del job
 * (`climateScheduler`), che resta l'unico punto che comanda i dispositivi.
 * Il comando manuale immediato lo invia già il pannello sul broker.
 */
export function registerClimateRoutes(app: FastifyInstance, deps: ClimateDeps): void {
  app.get(
    '/api/climate/:deviceId/schedules',
    { preHandler: requireAuth(deps) },
    async (request) => {
      const { deviceId } = request.params as { deviceId: string };
      const device = await loadClimateDevice(deps.db, deviceId);
      const rows = await deps.db.listClimateSchedules(deviceId);
      const runtime = await deps.db.getClimateRuntime(deviceId);
      const windows = normalizeWindows(rows);
      const now = new Date();
      const active = resolveActiveWindow(windows, now);
      const next = nextWindowStart(windows, now);

      return {
        deviceId,
        deviceName: device.name,
        schedules: rows.map(toScheduleDto),
        runtime: toRuntimeDto(runtime, now),
        activeSchedule: active
          ? {
              startTime: timeOfMinutes(active.startMinute),
              endTime: timeOfMinutes(active.endMinute),
              targetTemp: active.targetTemp,
              preset: active.preset,
              endsAt: activeWindowEnd(windows, now)?.getTime() ?? null,
            }
          : null,
        nextChangeAt: next?.at.getTime() ?? null,
      };
    },
  );

  app.post(
    '/api/climate/:deviceId/schedules',
    { preHandler: requireRole(deps, ['admin', 'family', 'kiosk']) },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      await loadClimateDevice(deps.db, deviceId);

      const parsed = schedulesBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, 'INVALID_BODY', 'Programma orario non valido', {
          field: parsed.error.issues[0]?.path.join('.') ?? 'schedules',
        });
      }

      const schedules = validateSchedules(parsed.data.schedules);
      await deps.db.replaceClimateSchedules(deviceId, schedules);
      const rows = await deps.db.listClimateSchedules(deviceId);
      return reply.code(200).send({
        deviceId,
        schedules: rows.map(toScheduleDto),
      });
    },
  );

  app.post(
    '/api/climate/:deviceId/override',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      await loadClimateDevice(deps.db, deviceId);

      const parsed = overrideBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, 'INVALID_BODY', 'Override non valido', {
          field: parsed.error.issues[0]?.path.join('.') ?? 'targetTemp',
        });
      }

      const { targetTemp, preset, durationMinutes, until } = parsed.data;
      const now = new Date();
      let untilDate: Date | null = null;

      if (durationMinutes !== undefined) {
        untilDate = new Date(now.getTime() + durationMinutes * 60_000);
      } else if (until === 'permanent') {
        untilDate = null;
      } else if (until !== undefined && until !== 'next_schedule') {
        const parsedUntil = new Date(until);
        if (parsedUntil.getTime() <= now.getTime()) {
          throw new HttpError(400, 'INVALID_BODY', 'La scadenza dell’override è nel passato', {
            field: 'until',
          });
        }
        untilDate = parsedUntil;
      } else {
        // Comportamento predefinito: fino all'inizio della fascia successiva.
        // Senza una fascia futura (programma vuoto) l'override diventa
        // permanente, perché nulla lo riallineerebbe.
        const windows = normalizeWindows(await deps.db.listClimateSchedules(deviceId));
        untilDate = nextWindowStart(windows, now)?.at ?? null;
      }

      await deps.db.setClimateOverride(deviceId, {
        targetTemp: Math.round(targetTemp * 10) / 10,
        preset: preset ?? MANUAL_PRESET,
        until: untilDate,
      });

      const runtime = await deps.db.getClimateRuntime(deviceId);
      return reply.code(201).send({
        deviceId,
        runtime: toRuntimeDto(runtime, now),
      });
    },
  );

  app.delete(
    '/api/climate/:deviceId/override',
    { preHandler: requireAuth(deps) },
    async (request) => {
      const { deviceId } = request.params as { deviceId: string };
      await loadClimateDevice(deps.db, deviceId);
      await deps.db.clearClimateOverride(deviceId);
      const runtime = await deps.db.getClimateRuntime(deviceId);
      return { deviceId, runtime: toRuntimeDto(runtime) };
    },
  );

  app.post(
    '/api/climate/:deviceId/vacation',
    { preHandler: requireRole(deps, ['admin', 'family', 'kiosk']) },
    async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string };
      await loadClimateDevice(deps.db, deviceId);

      const parsed = vacationBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, 'INVALID_BODY', 'Modalità vacanza non valida');
      }

      const { active, until } = parsed.data;
      if (!active) {
        await deps.db.setClimateVacation(deviceId, { active: false, until: null });
      } else {
        let untilDate: Date | null = null;
        if (until) {
          const parsedUntil = new Date(until);
          if (parsedUntil.getTime() <= Date.now()) {
            throw new HttpError(400, 'INVALID_BODY', 'Il rientro deve essere nel futuro', {
              field: 'until',
            });
          }
          untilDate = parsedUntil;
        }
        await deps.db.setClimateVacation(deviceId, { active: true, until: untilDate });
      }

      const runtime = await deps.db.getClimateRuntime(deviceId);
      return reply.code(201).send({ deviceId, runtime: toRuntimeDto(runtime) });
    },
  );
}
