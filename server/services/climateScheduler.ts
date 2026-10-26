import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';

import type { Database } from '../db.js';
import { timestampMs } from '../db.js';
import type {
  AuthConfig,
  ClimatePreset,
  ClimateRuntimeRow,
  ClimateScheduleRow,
  DeviceRow,
} from '../types.js';

/**
 * Cronotermostato settimanale · motore di automazione.
 *
 * Ogni minuto, per ogni dispositivo `type = 'climate'`:
 *
 * 1. **override** → se è attivo (`override_until` futuro o assente = permanente)
 *    il programma è sospeso: comanda il setpoint manuale;
 * 2. **scadenza** → un override appena scaduto viene azzerato e il dispositivo
 *    torna sulla fascia corrente nello stesso giro (nessun minuto di stato
 *    ambiguo);
 * 3. **vacanza** → impianto spento (`off`) finché `vacation_until` è futuro o
 *    assente;
 * 4. **fascia attiva** → `day_of_week` + ora locale del server; fuori da ogni
 *    fascia il termostato va in `off` (lo spegnimento tra le fasce è parte del
 *    programma, non un errore);
 * 5. **pubblicazione** → solo se il setpoint differisce dall'ultimo trasmesso:
 *    un publish al minuto su un broker locale è rumore inutile e consuma la
 *    batteria delle valvole.
 *
 * Se un dispositivo non ha **nessuna** fascia configurata il motore non lo
 * tocca: non è compito di un cronotermostato appena aggiunto spegnere un
 * impianto che nessuno ha ancora programmato.
 */

/** Cadenza del job: 60 s, come richiesto dal criterio di accettazione. */
export const CLIMATE_TICK_MS = 60_000;

/** Sotto questa differenza due setpoint sono lo stesso comando. */
const TEMP_EPSILON = 0.05;

export interface NormalizedWindow {
  dayOfWeek: number;
  /** Minuti dalla mezzanotte, estremi: `[start, end)`. */
  startMinute: number;
  endMinute: number;
  targetTemp: number;
  preset: ClimatePreset;
}

export interface ClimateTarget {
  /** `null` = nessun setpoint (impianto spento). */
  temp: number | null;
  preset: ClimatePreset;
}

export interface PublishedCommand {
  topic: string;
  payload: string;
}

/** Esito del piano per un singolo dispositivo (puro, testabile senza DB). */
export interface ClimatePlan {
  reason: 'no-program' | 'schedule' | 'override' | 'vacation' | 'gap' | 'unchanged';
  target: ClimateTarget;
  commands: PublishedCommand[];
  /** Override/vacanza scaduti da azzerare prima di comandare. */
  clearOverride: boolean;
  clearVacation: boolean;
}

// ── Tempo ───────────────────────────────────────────────────────────────────

/**
 * `HH:MM[:SS]` → minuti dalla mezzanotte. PostgreSQL restituisce `TIME` come
 * stringa (`06:00:00`) e accetta `24:00`, che qui diventa 1440: una fascia
 * `00:00 → 24:00` copre l'intera giornata.
 */
export function minutesOfTime(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  const parsedHours = Number.parseInt(hours, 10);
  const parsedMinutes = Number.parseInt(minutes, 10);
  if (!Number.isFinite(parsedHours) || !Number.isFinite(parsedMinutes)) return 0;
  return parsedHours * 60 + parsedMinutes;
}

/** Minuti dalla mezzanotte → `HH:MM` (1440 → `24:00`). */
export function timeOfMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** `Date` → minuti dalla mezzanotte dell'ora locale del server. */
export function minutesOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

/** Riga del database → fascia normalizzata; scarta orari incoerenti. */
export function normalizeWindows(rows: readonly ClimateScheduleRow[]): NormalizedWindow[] {
  return rows
    .filter((row) => row.is_active)
    .map((row) => ({
      dayOfWeek: Number(row.day_of_week),
      startMinute: minutesOfTime(row.start_time),
      endMinute: minutesOfTime(row.end_time),
      targetTemp: Number(row.target_temp),
      preset: (row.hvac_mode as ClimatePreset) ?? 'auto',
    }))
    .filter((window) => window.startMinute < window.endMinute)
    .sort((left, right) =>
      left.dayOfWeek === right.dayOfWeek
        ? left.startMinute - right.startMinute
        : left.dayOfWeek - right.dayOfWeek,
    );
}

/** Fascia che contiene l'istante richiesto (`start <= now < end`). */
export function resolveActiveWindow(
  windows: readonly NormalizedWindow[],
  at: Date,
): NormalizedWindow | null {
  const day = at.getDay();
  const minute = minutesOfDay(at);
  return (
    windows.find(
      (window) =>
        window.dayOfWeek === day && window.startMinute <= minute && minute < window.endMinute,
    ) ?? null
  );
}

/**
 * Inizio della prossima fascia **dopo** `at`, guardando 7 giorni avanti.
 * Usato da "Mantieni fino al prossimo cambio orario": `null` quando la
 * settimana è vuota (in quel caso l'override resta permanente).
 */
export function nextWindowStart(
  windows: readonly NormalizedWindow[],
  at: Date,
): { at: Date; window: NormalizedWindow } | null {
  if (windows.length === 0) return null;

  const baseDay = at.getDay();
  const nowMinute = minutesOfDay(at);
  let best: { dayOffset: number; minute: number; window: NormalizedWindow } | null = null;

  for (const window of windows) {
    for (let offset = 0; offset <= 7; offset += 1) {
      if ((baseDay + offset) % 7 !== window.dayOfWeek) continue;
      // Oggi valgono solo le fasce non ancora iniziate.
      if (offset === 0 && window.startMinute <= nowMinute) continue;
      const candidate = { dayOffset: offset, minute: window.startMinute, window };
      if (
        !best ||
        candidate.dayOffset < best.dayOffset ||
        (candidate.dayOffset === best.dayOffset && candidate.minute < best.minute)
      ) {
        best = candidate;
      }
    }
  }

  if (!best) return null;
  return {
    at: new Date(
      at.getFullYear(),
      at.getMonth(),
      at.getDate() + best.dayOffset,
      Math.floor(best.minute / 60),
      best.minute % 60,
      0,
      0,
    ),
    window: best.window,
  };
}

/** Fine della fascia corrente, per messaggi tipo "fino alle 18:30". */
export function activeWindowEnd(
  windows: readonly NormalizedWindow[],
  at: Date,
): Date | null {
  const window = resolveActiveWindow(windows, at);
  if (!window) return null;
  return new Date(
    at.getFullYear(),
    at.getMonth(),
    at.getDate(),
    Math.floor(window.endMinute / 60),
    window.endMinute % 60,
    0,
    0,
  );
}

// ── Override / vacanza ──────────────────────────────────────────────────────

export function isOverrideActive(runtime: ClimateRuntimeRow, at: Date): boolean {
  if (runtime.override_target_temp === null) return false;
  const until = timestampMs(runtime.override_until);
  // `override_until` assente = permanente: dura finché l'utente non lo annulla.
  return runtime.override_until === null || until > at.getTime();
}

export function isVacationActive(runtime: ClimateRuntimeRow, at: Date): boolean {
  if (!runtime.vacation_mode) return false;
  const until = timestampMs(runtime.vacation_until);
  return runtime.vacation_until === null || until > at.getTime();
}

/** Preset manuale predefinito: il setpoint scelto a mano è un comfort. */
export const MANUAL_PRESET: ClimatePreset = 'comfort';

// ── Comandi MQTT ────────────────────────────────────────────────────────────

/**
 * Modalità firmware per un preset. Il cronotermostato programma una
 * *temperatura*: `off` spegne, ogni altro preset scalda fino al setpoint
 * (`eco` e `comfort` sono etichette di programma, non modalità del firmware).
 */
function firmwareModeFor(preset: ClimatePreset): 'off' | 'heat' {
  return preset === 'off' ? 'off' : 'heat';
}

/** Shelly TRV non ha un "off": la fascia off diventa la soglia antigelo. */
const SHELLY_FROST_TEMP = 5;

function shellyChannel(device: DeviceRow): number {
  const raw = device.field_map?.['channel'];
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Traduzione del setpoint nel payload dell'adapter dichiarato in
 * `devices.adapter`: gli stessi topic che il client usa per i comandi manuali,
 * così il dispositivo riceve un solo dialetto.
 */
export function buildClimateCommands(
  device: DeviceRow,
  target: ClimateTarget,
): PublishedCommand[] {
  const topic = device.command_topic?.trim();
  if (!topic) return [];
  const mode = firmwareModeFor(target.preset);

  switch (device.adapter) {
    case 'tasmota': {
      const commands: PublishedCommand[] = [];
      if (target.temp !== null) {
        commands.push({ topic: `${topic}/Setpoint`, payload: String(target.temp) });
      }
      commands.push({ topic: `${topic}/Mode`, payload: mode });
      return commands;
    }
    case 'shelly': {
      const temp = target.temp ?? SHELLY_FROST_TEMP;
      return [
        {
          topic,
          payload: JSON.stringify({
            id: Math.floor(Math.random() * 100_000),
            src: 'wallos-scheduler',
            method: 'Thermostat.SetConfig',
            params: { id: shellyChannel(device), config: { target_C: temp } },
          }),
        },
      ];
    }
    case 'custom-json':
    case 'ha-discovery': {
      const payload: Record<string, unknown> = { mode: target.preset };
      if (target.temp !== null) payload['target_temperature'] = target.temp;
      return [{ topic, payload: JSON.stringify(payload) }];
    }
    case 'zigbee2mqtt':
    default: {
      const payload: Record<string, unknown> = { system_mode: mode };
      if (target.temp !== null) payload['occupied_heating_setpoint'] = target.temp;
      return [{ topic, payload: JSON.stringify(payload) }];
    }
  }
}

// ── Piano ───────────────────────────────────────────────────────────────────

function sameTarget(runtime: ClimateRuntimeRow, target: ClimateTarget): boolean {
  const lastTemp = runtime.last_sent_target_temp === null
    ? null
    : Number(runtime.last_sent_target_temp);
  const tempMatches =
    lastTemp === null || target.temp === null
      ? lastTemp === target.temp
      : Math.abs(lastTemp - target.temp) < TEMP_EPSILON;
  return (
    runtime.last_sent_at !== null &&
    tempMatches &&
    runtime.last_sent_hvac_mode === target.preset
  );
}

/**
 * Decide cosa fare per un dispositivo. Funzione pura: le scritture su DB le fa
 * il tick, così i casi limite (scadenza, vacanza, buco tra le fasce) sono
 * verificabili senza un database.
 */
export function planClimateDevice(
  device: DeviceRow,
  runtime: ClimateRuntimeRow,
  windows: readonly NormalizedWindow[],
  at: Date,
): ClimatePlan {
  const overrideActive = isOverrideActive(runtime, at);
  const vacationActive = isVacationActive(runtime, at);
  const clearOverride = !overrideActive && (runtime.override_target_temp !== null);
  const clearVacation = !vacationActive && (runtime.vacation_mode || runtime.vacation_until !== null);

  if (vacationActive) {
    return {
      reason: 'vacation',
      target: { temp: null, preset: 'off' },
      commands: buildClimateCommands(device, { temp: null, preset: 'off' }),
      clearOverride,
      clearVacation: false,
    };
  }

  if (overrideActive) {
    const target: ClimateTarget = {
      temp: Number(runtime.override_target_temp),
      preset: (runtime.override_hvac_mode as ClimatePreset | null) ?? MANUAL_PRESET,
    };
    return {
      reason: 'override',
      target,
      commands: sameTarget(runtime, target) ? [] : buildClimateCommands(device, target),
      clearOverride: false,
      clearVacation,
    };
  }

  // Nessun programma configurato: il motore non tocca il dispositivo.
  if (windows.length === 0) {
    return {
      reason: 'no-program',
      target: { temp: null, preset: 'off' },
      commands: [],
      clearOverride,
      clearVacation,
    };
  }

  const active = resolveActiveWindow(windows, at);
  const target: ClimateTarget = active
    ? { temp: active.targetTemp, preset: active.preset }
    : { temp: null, preset: 'off' };
  const unchanged = sameTarget(runtime, target);

  return {
    reason: unchanged ? 'unchanged' : active ? 'schedule' : 'gap',
    target,
    commands: unchanged ? [] : buildClimateCommands(device, target),
    clearOverride,
    clearVacation,
  };
}

// ── Pubblicazione ───────────────────────────────────────────────────────────

export interface ClimatePublisher {
  /** `false` = nessun broker disponibile: il setpoint non va memorizzato. */
  publish(topic: string, payload: string): boolean;
  close(): Promise<void>;
}

/**
 * Connessione persistente al broker locale per i comandi programmati. QoS 1:
 * mqtt.js accoda finché la socket non è pronta, quindi un broker che riparte
 * dopo il server non perde il primo setpoint.
 */
export function createMqttClimatePublisher(
  config: AuthConfig,
  log?: FastifyBaseLogger,
): ClimatePublisher {
  const settings = config.mqtt;
  if (!settings.url) {
    log?.warn(
      'cronotermostato: MQTT_HOST/MQTT_SERVER_URL assenti, i comandi programmati ' +
        'non vengono pubblicati (le fasce restano salvate e ripartono appena il broker è configurato)',
    );
    return {
      publish: () => false,
      close: () => Promise.resolve(),
    };
  }

  let client: MqttClient | null = mqtt.connect(settings.url, {
    clientId: `wallos-climate-${process.pid}-${Math.random().toString(16).slice(2, 6)}`,
    reconnectPeriod: 2_000,
    connectTimeout: 5_000,
    clean: true,
    protocolVersion: 4,
    ...(settings.username ? { username: settings.username } : {}),
    ...(settings.password ? { password: settings.password } : {}),
  });

  client.on('error', (error) => {
    // Senza listener l'evento `error` farebbe terminare il processo.
    log?.warn(`cronotermostato: errore broker MQTT (${settings.url}): ${error.message}`);
  });
  log?.info(`cronotermostato: comandi programmati via ${settings.url}`);

  return {
    publish(topic, payload) {
      const socket = client;
      if (!socket) return false;
      socket.publish(topic, payload, { qos: 1 }, (error) => {
        if (error) {
          log?.warn(`cronotermostato: publish fallito su ${topic}: ${error.message}`);
        }
      });
      return true;
    },
    close() {
      if (!client) return Promise.resolve();
      const socket = client;
      client = null;
      return new Promise<void>((resolve) => {
        socket.end(true, () => resolve());
      });
    },
  };
}

// ── Job ─────────────────────────────────────────────────────────────────────

export interface ClimateTickResult {
  evaluated: number;
  published: number;
  unchanged: number;
  cleared: number;
  errors: number;
  /** Dettaglio per log/diagnostica: un elemento per dispositivo comandato. */
  details: string[];
}

export interface ClimateScheduler {
  /** Un giro completo; esposto per i test e per un eventuale trigger manuale. */
  tick(now?: Date): Promise<ClimateTickResult>;
  start(): void;
  stop(): void;
}

export interface ClimateSchedulerDeps {
  db: Database;
  publisher: ClimatePublisher;
  log?: FastifyBaseLogger;
  /** Intervallo del job periodico (default 60 s). */
  intervalMs?: number;
}

export function createClimateScheduler({
  db,
  publisher,
  log,
  intervalMs = CLIMATE_TICK_MS,
}: ClimateSchedulerDeps): ClimateScheduler {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(now = new Date()): Promise<ClimateTickResult> {
    const result: ClimateTickResult = {
      evaluated: 0,
      published: 0,
      unchanged: 0,
      cleared: 0,
      errors: 0,
      details: [],
    };

    const devices = await db.listClimateDevices();
    const runtimes = new Map((await db.listClimateRuntimes()).map((row) => [row.device_id, row]));

    for (const device of devices) {
      result.evaluated += 1;
      try {
        const runtime = runtimes.get(device.id) ?? (await db.getClimateRuntime(device.id));
        const windows = normalizeWindows(await db.listClimateSchedules(device.id));
        const plan = planClimateDevice(device, runtime, windows, now);

        if (plan.clearOverride) {
          await db.clearClimateOverride(device.id);
          result.cleared += 1;
          result.details.push(`${device.id}: override scaduto, riallineato al programma`);
        }
        if (plan.clearVacation) {
          await db.clearClimateVacation(device.id);
          result.cleared += 1;
          result.details.push(`${device.id}: vacanza terminata`);
        }

        if (plan.commands.length === 0) {
          if (plan.reason === 'unchanged' || plan.reason === 'no-program') result.unchanged += 1;
          continue;
        }

        const accepted = plan.commands.every((command) =>
          publisher.publish(command.topic, command.payload),
        );
        if (!accepted) {
          // Nessun broker: non memorizzare il setpoint, così il prossimo giro
          // riprova invece di considerarlo già trasmesso.
          result.errors += 1;
          continue;
        }

        await db.recordClimateCommand(device.id, plan.target.temp, plan.target.preset, now);
        result.published += 1;
        result.details.push(
          `${device.id}: ${plan.reason} → ${plan.target.preset} ${
            plan.target.temp === null ? 'off' : `${plan.target.temp} °C`
          }`,
        );
      } catch (error) {
        result.errors += 1;
        log?.warn(
          `cronotermostato: elaborazione ${device.id} fallita: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }

  return {
    tick,
    start() {
      if (timer) return;
      // Primo giro subito: dopo un riavvio il pannello non deve aspettare un
      // minuto per vedere il setpoint programmato.
      void tick().catch((error: unknown) => {
        log?.warn(
          `cronotermostato: primo giro fallito: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      timer = setInterval(() => {
        // Un giro lento (database lento) non deve accumulare esecuzioni.
        if (running) return;
        running = true;
        void tick()
          .catch((error: unknown) => {
            log?.warn(
              `cronotermostato: giro fallito: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      // `unref`: il job non tiene vivo il processo da solo.
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
