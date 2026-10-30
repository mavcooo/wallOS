import type { FastifyBaseLogger } from 'fastify';

import type { Database, NewAutomationLog } from '../db.js';
import { createMqttLink, type MqttLink } from '../mqttClient.js';
import { KeyedAsyncLock } from '../utils/keyedAsyncLock.js';
import { CronError, localMinuteOfDay, matchesCron, minuteStamp, parseCron } from './cron.js';
import type { ParsedCron } from './cron.js';
import { sunEventLocalMinutes } from './sun.js';
import {
  commandTargetFromRow,
  encodeDeviceAction,
  type CommandTarget,
  type DeviceAction,
} from './commandEncoder.js';
import type {
  AuthConfig,
  AutomationAction,
  AutomationActionOutcome,
  AutomationCommandOutcome,
  AutomationCondition,
  AutomationConfig,
  AutomationLogRow,
  AutomationRow,
  AutomationTriggerType,
  DeviceAutomationActivity,
  MqttAutomationAction,
  MqttStateTriggerConfig,
  ResolvedAutomation,
  ScenarioAutomationAction,
  SunEventName,
  SunEventTriggerConfig,
  TimeCronTriggerConfig,
} from '../types.js';

/**
 * Motore di automazioni domotiche · Trigger → Conditions → Actions.
 *
 * Vive nel processo del server, non nel browser: il pannello a parete può
 * essere in standby, spento o disconnesso e la casa deve continuare a
 * reagire. Ogni valutazione lavora su una **cache in memoria** caricata dal
 * database (`reload()`), quindi il percorso caldo di un trigger MQTT non fa
 * nessuna query prima di pubblicare il comando: la lettura del DB avviene solo
 * per scrivere il log, dopo che i comandi sono già partiti.
 *
 * - **trigger mqtt_state** → il link MQTT del server (`server/mqttClient.ts`)
 *   inoltra ogni messaggio; il trigger è *edge-triggered*: scatta quando il
 *   valore osservato **cambia**, così un sensore di movimento che ripubblica
 *   `ON` ogni cinque secondi non riaccende la luce ogni volta;
 * - **trigger time_cron** → valutato una volta al minuto sull'orologio locale
 *   del server (stessa base temporale del cronotermostato);
 * - **trigger sun_event** → alba/tramonto calcolati dalle coordinate del
 *   `.env`, con sfasamento in minuti;
 * - **condizioni** → `time_range`, `device_state`, `user_present`; **AND** fra
 *   le condizioni dello stesso gruppo, **OR** fra i gruppi (`conditions` è il
 *   primo, `condition_groups` gli altri). Un dato mancante vale `false`: meglio
 *   una regola che non scatta di una che scatta alla cieca;
 * - **azioni** → sequenza ordinata con `delayMs`: un comando MQTT diretto
 *   oppure uno scenario salvato in `scenarios`, tradotto in comandi da
 *   `commandEncoder` (`src/mqtt/adapters` è il gemello nel pannello). Esito
 *   registrato in `automation_logs` con l'elenco dei comandi inviati.
 *
 * L'errore di una regola non interrompe le altre: ogni valutazione è isolata e
 * l'eccezione finisce nel log della regola.
 *
 * **Concorrenza.** Ogni valutazione è asincrona e un sensore pubblica a 1–2 Hz:
 * due messaggi ravvicinati possono superare entrambi il controllo dello stato
 * prima che la prima azione comandi il relè (TOCTOU). Le esecuzioni della
 * stessa regola passano quindi per un `KeyedAsyncLock`, e la seconda
 * ricontrolla il timestamp di ultima esecuzione **dopo** aver ottenuto il lock:
 * la finestra di deduplicazione è `throttle_ms` (default 150 ms). Regole
 * diverse restano parallele.
 */

/** Cadenza del tick dei trigger temporali: 60 s, come il criterio di latenza. */
export const AUTOMATION_TICK_MS = 60_000;

/** Ritardo massimo ammesso fra due azioni: oltre è un errore di configurazione. */
export const MAX_ACTION_DELAY_MS = 60 * 60_000;

/** Retention dei log: finestra temporale e righe per regola. */
export const LOG_RETENTION_DAYS = 90;
export const LOG_KEEP_PER_AUTOMATION = 500;

/** Frequenza della pulizia dei log (il motore la invoca dal tick). */
const LOG_CLEANUP_INTERVAL_MS = 60 * 60_000;

/** Sfasamento massimo delle regole solari rispetto all'effemeride. */
const MAX_SUN_OFFSET_MINUTES = 12 * 60;

// ── Concorrenza e deduplicazione ────────────────────────────────────────────

/**
 * Finestra di deduplicazione predefinita fra due esecuzioni della stessa
 * regola: copre un burst di sensori a 1–2 Hz senza sopprimere una vera
 * sequenza uomo-azione (spegnimento e riaccensione a distanza di un secondo).
 */
export const DEFAULT_AUTOMATION_THROTTLE_MS = 150;

/** Tetto di `throttle_ms`: oltre, un comando di sicurezza arriverebbe tardi. */
export const MAX_AUTOMATION_THROTTLE_MS = 10 * 60_000;

/** Attesa massima per il lock di una regola prima di dichiarare il timeout. */
export const AUTOMATION_LOCK_TIMEOUT_MS = 500;

/**
 * Chiave del lock: la regola. Le esecuzioni della stessa regola sono
 * serializzate anche quando il trigger arriva da dispositivi diversi (il
 * cooldown è per regola e le azioni comandano gli stessi attuatori); regole
 * diverse restano invece parallele. Il prefisso tiene le chiavi del motore
 * distinte da eventuali altri usi dello stesso lock.
 */
export function automationLockKey(ruleId: string): string {
  return `automation:${ruleId}`;
}

// ── Topic MQTT ──────────────────────────────────────────────────────────────

/**
 * Corrispondenza fra filtro con wildcard MQTT e topic concreto:
 * `+` vale un livello, `#` (solo in coda) vale i livelli restanti.
 */
export function topicMatches(filter: string, topic: string): boolean {
  const filterLevels = filter.trim().split('/');
  const topicLevels = topic.split('/');

  for (let index = 0; index < filterLevels.length; index += 1) {
    const level = filterLevels[index];
    if (level === '#') return index === filterLevels.length - 1;
    const current = topicLevels[index];
    if (current === undefined) return false;
    if (level !== '+' && level !== current) return false;
  }

  return filterLevels.length === topicLevels.length;
}

/** Estrae il valore da confrontare: chiave JSON o payload grezzo. */
export function extractPayloadValue(payload: string, payloadKey?: string): string {
  const text = payload.trim();
  if (!payloadKey) return text;

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)[payloadKey];
      if (value === undefined) return '';
      return typeof value === 'string' ? value.trim() : String(value);
    }
  } catch {
    // Payload non JSON: il topic pubblica un valore semplice, si confronta quello.
  }

  return text;
}

/** Normalizza i valori "veri" dei firmware (ON, true, 1) per il confronto. */
function normalizeValue(value: string): string {
  const text = value.trim();
  const lowered = text.toLowerCase();
  if (lowered === 'on' || lowered === 'true' || lowered === '1') return 'true';
  if (lowered === 'off' || lowered === 'false' || lowered === '0') return 'false';
  return lowered;
}

/**
 * Confronto fra valore osservato e valore atteso. Poco tollerante di
 * proposito: `ON/on/1/true` sono la stessa cosa (i firmware non sono
 * coerenti), tutto il resto deve combaciare.
 */
export function valueMatches(actual: string, expected: string | number | boolean | undefined): boolean {
  if (expected === undefined) return actual.length > 0;
  if (typeof expected === 'number') {
    const parsed = Number(actual);
    return Number.isFinite(parsed) && parsed === expected;
  }
  return normalizeValue(actual) === normalizeValue(String(expected));
}

/**
 * Stato di un dispositivo per la condizione `device_state`. Confronta il
 * payload così com'è e, se è un oggetto JSON, le chiavi di stato abituali:
 * un payload `{"power":"OFF"}` soddisfa `expectedState: "OFF"`.
 */
export function stateMatches(payload: string | undefined, expectedState: string): boolean {
  if (payload === undefined) return false;
  const text = payload.trim();
  if (valueMatches(text, expectedState)) return true;

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const entries = Object.entries(parsed as Record<string, unknown>);
    return entries.some(([key, value]) => {
      if (value === null) return false;
      if (typeof value === 'object') return false;
      if (!STATE_KEYS.has(key)) return false;
      return valueMatches(String(value), expectedState);
    });
  } catch {
    return false;
  }
}

/** Chiavi di stato riconosciute nei payload JSON dei vari adapter. */
const STATE_KEYS = new Set(['state', 'power', 'occupancy', 'value', 'status', 'mode', 'contact']);

/** Intervallo orario `HH:MM`; `start === end` vale tutta la giornata. */
export function evaluateTimeRange(start: string, end: string, at: Date): boolean {
  const startMinute = minutesOfClock(start);
  const endMinute = minutesOfClock(end);
  if (startMinute === null || endMinute === null) return false;
  const now = localMinuteOfDay(at);
  if (startMinute === endMinute) return true;
  // Fascia che scavalca la mezzanotte: 23:00 → 06:00 è [23:00, 24:00) ∪ [00:00, 06:00).
  return startMinute < endMinute
    ? now >= startMinute && now < endMinute
    : now >= startMinute || now < endMinute;
}

function minutesOfClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Presenza in casa dal topic configurato: JSON, stringhe e valori dei firmware. */
export function parsePresence(payload: string): boolean {
  const text = payload.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'boolean') return parsed;
    if (typeof parsed === 'number') return parsed > 0;
    if (typeof parsed === 'string') return TRUTHY_PRESENCE.has(normalizePresence(parsed));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['occupancy', 'present', 'home', 'presence', 'state']) {
        const value = record[key];
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return TRUTHY_PRESENCE.has(normalizePresence(value));
        if (typeof value === 'number') return value > 0;
      }
      return false;
    }
  } catch {
    // Payload testuale semplice.
  }
  return TRUTHY_PRESENCE.has(normalizePresence(text));
}

function normalizePresence(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const TRUTHY_PRESENCE = new Set(['on', 'true', '1', 'home', 'present', 'occupied', 'online', 'yes']);

export interface ConditionContext {
  at: Date;
  /** `null` = presenza sconosciuta (nessun topic configurato o nessun messaggio). */
  presence: boolean | null;
  /** Ultimo payload noto del dispositivo, se il motore lo ha già visto. */
  stateOf: (deviceId: string) => string | undefined;
}

/** Una singola condizione; un dato mancante non la soddisfa mai. */
export function evaluateCondition(
  condition: AutomationCondition,
  context: ConditionContext,
): boolean {
  switch (condition.type) {
    case 'time_range':
      return evaluateTimeRange(condition.start, condition.end, context.at);
    case 'device_state':
      return stateMatches(context.stateOf(condition.deviceId), condition.expectedState);
    case 'user_present':
      return context.presence !== null && context.presence === condition.requireHome;
    default:
      return false;
  }
}

/**
 * Gruppi di condizioni: AND dentro il gruppo, OR fra i gruppi.
 *
 * - Nessun gruppo (o tutti vuoti) → la regola scatta: è il caso "solo trigger",
 *   che era `conditions: []` prima dei gruppi;
 * - un gruppo vuoto viene ignorato invece di valere "sempre vero": altrimenti
 *   un gruppo lasciato a metà (`[[]]`) annullerebbe silenziosamente gli altri.
 *
 * Con un solo gruppo il risultato è identico alla vecchia valutazione in AND,
 * quindi le regole salvate prima della migrazione 005 non cambiano semantica.
 */
export function evaluateConditionGroups(
  groups: readonly (readonly AutomationCondition[])[],
  context: ConditionContext,
): boolean {
  const meaningful = groups.filter((group) => group.length > 0);
  if (meaningful.length === 0) return true;
  return meaningful.some((group) =>
    group.every((condition) => evaluateCondition(condition, context)),
  );
}

/** Condizioni di un unico gruppo, in AND logico. */
export function evaluateConditions(
  conditions: readonly AutomationCondition[],
  context: ConditionContext,
): boolean {
  return evaluateConditionGroups([conditions], context);
}

// ── Configurazione delle regole ─────────────────────────────────────────────

const TRIGGER_TYPES: readonly AutomationTriggerType[] = ['mqtt_state', 'time_cron', 'sun_event'];
const SUN_EVENTS: readonly SunEventName[] = ['sunrise', 'sunset'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown, maxLength = 256): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function parseCondition(value: unknown): AutomationCondition | null {
  const record = asRecord(value);
  if (!record) return null;

  const start = asText(record['start'], 8);
  const end = asText(record['end'], 8);
  const type = record['type'];

  if (type === 'time_range') {
    if (!start || !end || minutesOfClock(start) === null || minutesOfClock(end) === null) return null;
    return { type: 'time_range', start, end };
  }
  if (type === 'device_state') {
    const deviceId = asText(record['deviceId'], 64);
    const expectedState = asText(record['expectedState'], 64);
    if (!deviceId || !expectedState) return null;
    return { type: 'device_state', deviceId, expectedState };
  }
  if (type === 'user_present') {
    return { type: 'user_present', requireHome: record['requireHome'] === true };
  }
  return null;
}

/**
 * `throttle_ms` opzionale: assente o malformato → default del motore; `0`
 * disabilita la deduplicazione per quella regola; i valori eccessivi vengono
 * limitati al tetto.
 */
function parseThrottleMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AUTOMATION_THROTTLE_MS;
  const throttleMs = Math.trunc(value);
  if (throttleMs <= 0) return throttleMs === 0 ? 0 : DEFAULT_AUTOMATION_THROTTLE_MS;
  return Math.min(throttleMs, MAX_AUTOMATION_THROTTLE_MS);
}

/** `delayMs` assente vale 0; `null` = valore fuori intervallo. */
function parseDelayMs(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const delayMs = Math.trunc(value);
  return delayMs < 0 || delayMs > MAX_ACTION_DELAY_MS ? null : delayMs;
}

/**
 * Azione della sequenza: comando MQTT diretto o scenario salvato.
 * `type` assente vale `mqtt`: è la forma dei record creati prima della
 * migrazione 005 e non va riscritta per poterli eseguire.
 */
function parseAction(value: unknown): AutomationAction | null {
  const record = asRecord(value);
  if (!record) return null;
  const delayMs = parseDelayMs(record['delayMs']);
  if (delayMs === null) return null;

  if (record['type'] === 'scenario') {
    const scenarioId = asText(record['scenarioId'], 64);
    return scenarioId ? { type: 'scenario', scenarioId, delayMs } : null;
  }

  const topic = asText(record['topic']);
  if (!topic) return null;
  const payload = record['payload'];
  if (typeof payload !== 'string' && typeof payload !== 'number' && typeof payload !== 'boolean') {
    return null;
  }
  return {
    type: 'mqtt',
    topic,
    payload: typeof payload === 'string' ? payload : String(payload),
    delayMs,
  } satisfies MqttAutomationAction;
}

/**
 * Passo di scenario letto da `scenarios.actions` (payload validato in scrittura
 * dalle route di topologia, qui solo riletto in modo difensivo).
 */
export interface ScenarioStep {
  deviceId: string;
  action: DeviceAction;
  delayMs: number;
}

function parseScenarioAction(value: unknown): DeviceAction | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = record['type'];
  const number = (key: string): number | null => {
    const raw = record[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  };
  const text = (key: string): string | null => asText(record[key], 64);

  switch (type) {
    case 'power':
      return typeof record['on'] === 'boolean' ? { type: 'power', on: record['on'] } : null;
    case 'brightness': {
      const brightness = number('brightness');
      return brightness === null ? null : { type: 'brightness', brightness };
    }
    case 'colorTemp': {
      const kelvin = number('kelvin');
      return kelvin === null ? null : { type: 'colorTemp', kelvin };
    }
    case 'targetTemp': {
      const targetTemp = number('targetTemp');
      return targetTemp === null ? null : { type: 'targetTemp', targetTemp };
    }
    case 'climateMode': {
      const mode = text('mode');
      return mode === null ? null : { type: 'climateMode', mode };
    }
    case 'fanSpeed': {
      const fanSpeed = text('fanSpeed');
      return fanSpeed === null ? null : { type: 'fanSpeed', fanSpeed };
    }
    case 'swing':
      return typeof record['swing'] === 'boolean' ? { type: 'swing', swing: record['swing'] } : null;
    case 'volume': {
      const volume = number('volume');
      return volume === null ? null : { type: 'volume', volume };
    }
    case 'source': {
      const source = text('source');
      return source === null ? null : { type: 'source', source };
    }
    default:
      return null;
  }
}

/** Passi di uno scenario: `null` se almeno un passo è inutilizzabile. */
export function parseScenarioSteps(actions: unknown): ScenarioStep[] | null {
  if (actions === null || actions === undefined) return [];
  if (!Array.isArray(actions)) return null;

  const steps: ScenarioStep[] = [];
  for (const raw of actions) {
    const record = asRecord(raw);
    const deviceId = record ? asText(record['deviceId'], 64) : null;
    const action = record ? parseScenarioAction(record['action']) : null;
    const delayMs = record ? parseDelayMs(record['delayMs']) : null;
    if (!deviceId || !action || delayMs === null) return null;
    steps.push({ deviceId, action, delayMs });
  }
  return steps;
}

/**
 * Riga del database → regola risolta e pronta per la valutazione.
 *
 * Non lancia mai: una regola scritta a mano o rimasta da una versione
 * precedente dello schema diventa `invalidReason` e resta visibile nel
 * pannello, senza far fallire il caricamento della cache né il tick.
 */
export function resolveAutomation(
  row: AutomationRow,
  config: AutomationConfig,
): ResolvedAutomation {
  const base = {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    throttleMs: parseThrottleMs(row.throttle_ms),
  };

  const triggerType = TRIGGER_TYPES.find((type) => type === row.trigger_type);
  if (!triggerType) {
    return {
      ...base,
      triggerType: 'mqtt_state',
      trigger: null,
      conditions: [],
      conditionGroups: [],
      actions: [],
      invalidReason: `Tipo di trigger sconosciuto: "${String(row.trigger_type)}"`,
    };
  }

  const triggerConfig = asRecord(row.trigger_config);
  const conditions: AutomationCondition[] = [];
  const conditionGroups: AutomationCondition[][] = [];
  const actions: AutomationAction[] = [];

  const CONDITION_ERROR =
    'Condizione non valida: tipi ammessi time_range, device_state, user_present';

  const rawConditions = Array.isArray(row.conditions) ? row.conditions : [];
  for (const raw of rawConditions) {
    const condition = parseCondition(raw);
    if (!condition) {
      return {
        ...base,
        triggerType,
        trigger: null,
        conditions: [],
        conditionGroups: [],
        actions: [],
        invalidReason: CONDITION_ERROR,
      };
    }
    conditions.push(condition);
  }

  // `condition_groups` è un array di gruppi: ogni voce deve essere un array di
  // condizioni valide, altrimenti la regola è inerte (mai una valutazione a metà).
  const rawGroups = Array.isArray(row.condition_groups) ? row.condition_groups : [];
  for (const rawGroup of rawGroups) {
    if (!Array.isArray(rawGroup)) {
      return {
        ...base,
        triggerType,
        trigger: null,
        conditions,
        conditionGroups: [],
        actions: [],
        invalidReason: 'Gruppo di condizioni non valido: atteso un array di condizioni',
      };
    }
    const group: AutomationCondition[] = [];
    for (const raw of rawGroup) {
      const condition = parseCondition(raw);
      if (!condition) {
        return {
          ...base,
          triggerType,
          trigger: null,
          conditions,
          conditionGroups: [],
          actions: [],
          invalidReason: `Gruppo di condizioni non valido: ${CONDITION_ERROR}`,
        };
      }
      group.push(condition);
    }
    conditionGroups.push(group);
  }

  const rawActions = Array.isArray(row.actions) ? row.actions : [];
  for (const raw of rawActions) {
    const action = parseAction(raw);
    if (!action) {
      return {
        ...base,
        triggerType,
        trigger: null,
        conditions,
        conditionGroups,
        actions: [],
        invalidReason:
          'Azione non valida: comando MQTT (topic, payload) o scenario (scenarioId), ' +
          'con delayMs tra 0 e 3600000',
      };
    }
    actions.push(action);
  }

  if (actions.length === 0) {
    return {
      ...base,
      triggerType,
      trigger: null,
      conditions,
      conditionGroups,
      actions,
      invalidReason: 'La regola non ha azioni: non ci sarebbe nulla da eseguire',
    };
  }

  const invalid = (reason: string): ResolvedAutomation => ({
    ...base,
    triggerType,
    trigger: null,
    conditions,
    conditionGroups,
    actions,
    invalidReason: reason,
  });

  if (!triggerConfig) return invalid('Configurazione del trigger assente o non valida');

  if (triggerType === 'mqtt_state') {
    const topic = asText(triggerConfig['topic']);
    if (!topic) return invalid('Il trigger MQTT richiede un topic');
    const payloadKey = asText(triggerConfig['payloadKey'], 64) ?? undefined;
    const expected = triggerConfig['expectedValue'];
    const expectedValue =
      typeof expected === 'string' || typeof expected === 'number' || typeof expected === 'boolean'
        ? expected
        : undefined;
    const trigger: MqttStateTriggerConfig = { topic, ...(payloadKey ? { payloadKey } : {}) };
    if (expectedValue !== undefined) trigger.expectedValue = expectedValue;
    return {
      ...base,
      triggerType,
      trigger,
      conditions,
      conditionGroups,
      actions,
      invalidReason: null,
    };
  }

  if (triggerType === 'time_cron') {
    const cron = asText(triggerConfig['cron'], 128);
    if (!cron) return invalid('Il trigger temporale richiede un’espressione cron');
    try {
      parseCron(cron);
    } catch (error) {
      const message = error instanceof CronError ? error.message : String(error);
      return invalid(message);
    }
    const trigger = { cron } satisfies TimeCronTriggerConfig;
    return { ...base, triggerType, trigger, conditions, conditionGroups, actions, invalidReason: null };
  }

  const event = SUN_EVENTS.find((name) => name === triggerConfig['event']);
  if (!event) return invalid('Il trigger solare richiede event "sunrise" o "sunset"');
  const rawOffset = triggerConfig['offsetMinutes'];
  const offsetMinutes =
    typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0;
  if (Math.abs(offsetMinutes) > MAX_SUN_OFFSET_MINUTES) {
    return invalid(`Sfasamento solare fuori intervallo (±${MAX_SUN_OFFSET_MINUTES} minuti)`);
  }
  if (config.latitude === null || config.longitude === null) {
    return invalid(
      'Automazioni solari disabilitate: imposta AUTOMATION_LATITUDE e AUTOMATION_LONGITUDE nel .env',
    );
  }
  return {
    ...base,
    triggerType,
    trigger: { event, offsetMinutes } satisfies SunEventTriggerConfig,
    conditions,
    conditionGroups,
    actions,
    invalidReason: null,
  };
}

// ── Esecuzione ──────────────────────────────────────────────────────────────

export interface AutomationRunResult {
  automationId: string;
  automationName: string;
  /** `mqtt:<topic>`, `cron:<expr>`, `sun:<event>` oppure `test`. */
  triggerSource: string;
  conditionsMet: boolean;
  actions: AutomationActionOutcome[];
  /** Latenza dalla ricezione del trigger all'ultima azione. */
  executionTimeMs: number;
  error: string | null;
  /** Riga scritta in `automation_logs` (assente se la scrittura è fallita). */
  log: AutomationLogRow | undefined;
}

/** Sottoinsieme di `Database` usato dal motore: i test iniettano un falso. */
export type AutomationDb = Pick<
  Database,
  | 'listActiveAutomations'
  | 'listDevices'
  | 'listScenarios'
  | 'findAutomationById'
  | 'insertAutomationLog'
  | 'recordAutomationRun'
  | 'cleanupAutomationLogs'
>;

export interface AutomationEngineDeps {
  db: AutomationDb;
  config: AuthConfig;
  log?: FastifyBaseLogger;
  /** Collegamento MQTT già costruito (test); assente → creato da `start()`. */
  link?: MqttLink;
  /** Cadenza del tick dei timer (default 60 s). */
  intervalMs?: number;
  /** Orologio iniettabile per i test. */
  now?: () => Date;
  /** Lock condiviso (test e diagnostica); assente → uno nuovo per il motore. */
  lock?: KeyedAsyncLock;
}

export interface AutomationEngine {
  /** Ricarica la cache dal database e riallinea le sottoscrizioni MQTT. */
  reload(): Promise<ResolvedAutomation[]>;
  /** Valutazione dei trigger temporali (cron e solari) per il minuto corrente. */
  tick(at?: Date): Promise<AutomationRunResult[]>;
  /** Messaggio MQTT: aggiorna lo stato in memoria e valuta le regole. */
  handleMessage(topic: string, payload: string): Promise<AutomationRunResult[]>;
  /** Esecuzione forzata che ignora le condizioni (`POST /test`). */
  runTest(id: string): Promise<AutomationRunResult>;
  /** Regole in cache, comprese quelle inattive e quelle non valide. */
  rules(): ResolvedAutomation[];
  /** Ultimo comando inviato a ciascun dispositivo (badge delle card). */
  activity(): DeviceAutomationActivity[];
  /** Topic sottoscritti sul broker (diagnostica). */
  subscriptions(): string[];
  start(): void;
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dateKey(at: Date): string {
  return minuteStamp(at).slice(0, 10);
}

export function createAutomationEngine(deps: AutomationEngineDeps): AutomationEngine {
  const { db, config, log, intervalMs = AUTOMATION_TICK_MS } = deps;
  const clock = deps.now ?? (() => new Date());
  const automationConfig = config.automation;

  const cache = new Map<string, ResolvedAutomation>();
  const cronCache = new Map<string, ParsedCron>();
  const subscribedTopics = new Set<string>();
  const states = new Map<string, string>();
  const deviceTopics = new Map<string, string>();
  const lastTriggerValues = new Map<string, string>();
  const lastCronFired = new Map<string, string>();
  const lastSunFired = new Map<string, string>();
  const running = new Set<string>();
  /** Serializza le esecuzioni della stessa regola sullo stesso dispositivo. */
  const engineLock = deps.lock ?? new KeyedAsyncLock();
  /** Timestamp (epoch ms) dell'ultima esecuzione automatica, per il cooldown. */
  const lastExecutionTimestamps = new Map<string, number>();
  /** Anagrafica dei comandi: un dispositivo può essere comandato da un'azione. */
  const targets = new Map<string, CommandTarget>();
  /** Topic di comando dichiarati, dal più specifico: `cmnd/luce/Dimmer` → `cmnd/luce`. */
  const commandPrefixes: { prefix: string; deviceId: string }[] = [];
  /** Scenari disponibili per le azioni di tipo `scenario`. */
  const scenarios = new Map<string, { id: string; label: string; steps: ScenarioStep[] | null }>();
  /** Ultimo comando inviato per device: alimenta il badge del pannello. */
  const activityByDevice = new Map<string, DeviceAutomationActivity>();

  let presence: boolean | null = null;
  let lastCleanupAt = 0;
  let timer: NodeJS.Timeout | null = null;
  let tickRunning = false;
  let link: MqttLink | null = deps.link ?? null;
  let messageHandlerBound = false;

  function stateOf(deviceId: string): string | undefined {
    const topic = deviceTopics.get(deviceId);
    return topic === undefined ? undefined : states.get(topic);
  }

  /**
   * Dispositivo a cui appartiene un topic di comando: match esatto oppure per
   * prefisso (`cmnd/luce/Dimmer`, `cmnd/luce/POWER1` sono sempre di `cmnd/luce`).
   */
  function deviceForCommandTopic(topic: string): string | undefined {
    for (const entry of commandPrefixes) {
      if (topic === entry.prefix || topic.startsWith(`${entry.prefix}/`)) return entry.deviceId;
    }
    return undefined;
  }

  /**
   * Pubblica un comando e ne registra l'esito. L'attività per il badge viene
   * scritta solo se il comando è partito davvero: un tentativo fallito non ha
   * comandato niente.
   */
  function publishCommand(
    automation: ResolvedAutomation,
    topic: string,
    payload: string,
    triggerSource: string,
    at: Date,
    scenario: { id: string; label: string } | null,
  ): AutomationCommandOutcome {
    const startedAt = Date.now();
    const sent = link?.publish(topic, payload) ?? false;
    const command: AutomationCommandOutcome = {
      topic,
      payload,
      status: sent ? 'sent' : 'failed',
      durationMs: Date.now() - startedAt,
    };
    if (!sent) {
      command.error = link?.enabled
        ? 'Comando non inviato al broker'
        : 'Broker MQTT non configurato: comando non inviato';
    }

    const deviceId = deviceForCommandTopic(topic);
    if (deviceId) {
      command.deviceId = deviceId;
      if (sent) {
        activityByDevice.set(deviceId, {
          deviceId,
          automationId: automation.id,
          automationName: automation.name,
          triggerSource,
          scenarioId: scenario?.id ?? null,
          scenarioLabel: scenario?.label ?? null,
          topic,
          payload,
          at: at.getTime(),
        });
      }
    }

    return command;
  }

  /** Stato dell'azione dedotto dai suoi comandi: un fallimento vince su tutto. */
  function actionOutcome(
    type: 'mqtt' | 'scenario',
    commands: AutomationCommandOutcome[],
    extra: Partial<AutomationActionOutcome>,
    startedAt: number,
  ): AutomationActionOutcome {
    const failed = commands.some((command) => command.status === 'failed');
    const sent = commands.some((command) => command.status === 'sent');
    return {
      type,
      status: failed ? 'failed' : sent ? 'sent' : 'skipped',
      commands,
      durationMs: Date.now() - startedAt,
      ...extra,
    };
  }

  function writeLog(entry: NewAutomationLog): Promise<AutomationLogRow | undefined> {
    return db
      .insertAutomationLog(entry)
      .catch((error: unknown) => {
        log?.warn(
          `automazioni: log non scritto per ${entry.automationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return undefined;
      });
  }

  /** Un'azione di comando MQTT diretto: un solo publish. */
  function runMqttAction(
    automation: ResolvedAutomation,
    action: MqttAutomationAction,
    triggerSource: string,
    at: Date,
  ): AutomationActionOutcome {
    const startedAt = Date.now();
    const command = publishCommand(automation, action.topic, action.payload, triggerSource, at, null);
    return actionOutcome('mqtt', [command], {}, startedAt);
  }

  /**
   * Un'azione di scenario: i passi vengono tradotti e pubblicati in sequenza,
   * con lo stesso dialetto del pannello (`encodeDeviceAction`). Un passo che
   * non si può eseguire viene registrato come `skipped` e gli altri proseguono:
   * un device senza topic di comando non deve fermare le luci dello scenario.
   */
  async function runScenarioAction(
    automation: ResolvedAutomation,
    action: ScenarioAutomationAction,
    triggerSource: string,
    at: Date,
  ): Promise<AutomationActionOutcome> {
    const startedAt = Date.now();
    const scenario = scenarios.get(action.scenarioId);
    if (!scenario) {
      return {
        type: 'scenario',
        status: 'failed',
        commands: [],
        scenarioId: action.scenarioId,
        error: `Scenario "${action.scenarioId}" non trovato`,
        durationMs: Date.now() - startedAt,
      };
    }

    const extra = { scenarioId: scenario.id, scenarioLabel: scenario.label };
    if (scenario.steps === null) {
      return {
        type: 'scenario',
        status: 'failed',
        commands: [],
        ...extra,
        error: `Scenario "${scenario.label}": passi non leggibili`,
        durationMs: Date.now() - startedAt,
      };
    }

    const commands: AutomationCommandOutcome[] = [];
    for (const step of scenario.steps) {
      const target = targets.get(step.deviceId);
      if (!target) {
        commands.push({
          deviceId: step.deviceId,
          status: 'skipped',
          error: 'Dispositivo non presente in anagrafica',
          durationMs: 0,
        });
        continue;
      }

      const encoded = encodeDeviceAction(target, step.action);
      if (!encoded) {
        commands.push({
          deviceId: step.deviceId,
          status: 'skipped',
          error: target.commandTopic
            ? 'Il dispositivo non supporta questa azione'
            : 'Il dispositivo non ha un topic di comando',
          durationMs: 0,
        });
        continue;
      }

      // Il ritardo del passo è cumulativo come nel pannello: si aspetta e poi
      // si invia, così lo scenario resta una sequenza ordinata.
      if (step.delayMs > 0) await sleep(step.delayMs);
      commands.push(
        publishCommand(automation, encoded.topic, encoded.payload, triggerSource, at, scenario),
      );
    }

    return actionOutcome('scenario', commands, extra, startedAt);
  }

  /**
   * Valuta ed esegue una regola. Il tratto sincrono (valutazione condizioni +
   * publish delle azioni senza ritardo) precede ogni `await`, quindi la
   * latenza trigger → broker resta quella del publish MQTT.
   *
   * `at` è l'istante del trigger per le condizioni e per il log; la latenza si
   * misura invece con `Date.now()`, così un orologio iniettato nei test non
   * falsa il cronometro.
   */
  async function runRule(
    rule: ResolvedAutomation,
    triggerSource: string,
    at: Date,
    bypassConditions: boolean,
    onExecuted?: () => void,
  ): Promise<AutomationRunResult> {
    const receivedMs = Date.now();
    const skipResult = (error: string): AutomationRunResult => ({
      automationId: rule.id,
      automationName: rule.name,
      triggerSource,
      conditionsMet: false,
      actions: [],
      executionTimeMs: Date.now() - receivedMs,
      error,
      log: undefined,
    });

    if (running.has(rule.id)) {
      // Una regola con ritardi lunghi non deve sovrapporsi a se stessa.
      return skipResult('Esecuzione precedente ancora in corso');
    }
    running.add(rule.id);

    try {
      const conditionsMet =
        bypassConditions ||
        evaluateConditionGroups([rule.conditions, ...rule.conditionGroups], {
          at,
          presence,
          stateOf,
        });
      const outcomes: AutomationActionOutcome[] = [];
      let error: string | null = null;

      if (conditionsMet) {
        // Il timestamp si aggiorna **prima** di comandare i dispositivi: se
        // un'azione fallisce la regola resta comunque "eseguita" e non
        // ritenta in raffica sullo stesso relè.
        onExecuted?.();
        for (const action of rule.actions) {
          if ((action.delayMs ?? 0) > 0) await sleep(action.delayMs ?? 0);
          const outcome =
            action.type === 'scenario'
              ? await runScenarioAction(rule, action, triggerSource, at)
              : runMqttAction(rule, action, triggerSource, at);
          outcomes.push(outcome);
          if (outcome.status === 'failed') {
            error ??=
              outcome.error ??
              outcome.commands.find((command) => command.error)?.error ??
              'Comando non inviato al broker';
          }
        }

        if (!bypassConditions) {
          // Un test manuale non è un trigger reale: il contatore resta quello
          // delle esecuzioni automatiche.
          await db.recordAutomationRun(rule.id, at).catch((cause: unknown) => {
            log?.warn(
              `automazioni: contatore non aggiornato per ${rule.id}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            );
          });
        }
      }

      const executionTimeMs = Date.now() - receivedMs;
      const entry: NewAutomationLog = {
        automationId: rule.id,
        triggerSource,
        conditionsMet,
        actionsExecuted: outcomes,
        executionTimeMs,
        errorMessage: error,
        triggeredAt: at,
      };

      // Il log si scrive dopo i comandi: non deve aggiungere latenza.
      const entryLog = await writeLog(entry);
      if (error) {
        log?.warn(`automazioni: ${rule.name} (${rule.id}) · ${error}`);
      }

      return {
        automationId: rule.id,
        automationName: rule.name,
        triggerSource,
        conditionsMet,
        actions: outcomes,
        executionTimeMs,
        error,
        log: entryLog,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const executionTimeMs = Date.now() - receivedMs;
      const entryLog = await writeLog({
        automationId: rule.id,
        triggerSource,
        conditionsMet: false,
        actionsExecuted: [],
        executionTimeMs,
        errorMessage: message,
        triggeredAt: at,
      });
      log?.warn(`automazioni: ${rule.name} (${rule.id}) fallita: ${message}`);
      return {
        automationId: rule.id,
        automationName: rule.name,
        triggerSource,
        conditionsMet: false,
        actions: [],
        executionTimeMs,
        error: message,
        log: entryLog,
      };
    } finally {
      running.delete(rule.id);
    }
  }

  /** `true` se la regola ha eseguito troppo di recente per questo trigger. */
  function isThrottled(rule: ResolvedAutomation, throttleMs: number): boolean {
    if (throttleMs <= 0) return false;
    const last = lastExecutionTimestamps.get(rule.id) ?? 0;
    // Orologio reale, non quello delle condizioni: un orologio iniettato nei
    // test non deve congelare la finestra di deduplicazione.
    return Date.now() - last < throttleMs;
  }

  /**
   * Esecuzione serializzata di una regola: lock per chiave, ricontrollo del
   * cooldown **dopo** l'acquisizione (TOCTOU) ed esecuzione.
   *
   * Restituisce `null` quando il trigger è stato soppresso dalla finestra di
   * deduplicazione: il chiamante non deve registrarlo come esecuzione. Un
   * timeout di acquisizione o un errore inatteso diventano un risultato con
   * `error`, così il messaggio MQTT non resta senza risposta.
   */
  async function runExclusive(
    rule: ResolvedAutomation,
    triggerSource: string,
    at: Date,
    bypassConditions: boolean,
    lockKey: string,
    throttleMs: number,
  ): Promise<AutomationRunResult | null> {
    if (isThrottled(rule, throttleMs)) return null;

    const receivedMs = Date.now();
    let release: (() => void) | null = null;

    try {
      release = await engineLock.acquire(lockKey, AUTOMATION_LOCK_TIMEOUT_MS);

      // Ricontrollo post-acquisizione: chi era in coda ha letto il timestamp
      // prima che il detentore precedente lo aggiornasse. È qui che si chiude
      // la finestra TOCTOU.
      if (isThrottled(rule, throttleMs)) return null;

      return await runRule(rule, triggerSource, at, bypassConditions, () => {
        lastExecutionTimestamps.set(rule.id, Date.now());
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log?.warn(`automazioni: ${rule.name} (${rule.id}) non eseguita · ${message}`);
      return {
        automationId: rule.id,
        automationName: rule.name,
        triggerSource,
        conditionsMet: false,
        actions: [],
        executionTimeMs: Date.now() - receivedMs,
        error: message,
        log: undefined,
      };
    } finally {
      // Rilascio su ogni ramo di uscita: inclusi cooldown, timeout e azione
      // fallita. `release()` è idempotente.
      release?.();
    }
  }

  async function cleanupLogsOncePerHour(at: Date): Promise<void> {
    if (at.getTime() - lastCleanupAt < LOG_CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = at.getTime();
    try {
      const removed = await db.cleanupAutomationLogs(LOG_RETENTION_DAYS, LOG_KEEP_PER_AUTOMATION);
      if (removed > 0) log?.info(`automazioni: ${removed} esecuzioni rimosse dal log (retention)`);
    } catch (error) {
      log?.warn(
        `automazioni: pulizia dei log fallita: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const engine: AutomationEngine = {
    async reload() {
      const [rows, devices, scenarioRows] = await Promise.all([
        db.listActiveAutomations(),
        db.listDevices(),
        db.listScenarios(),
      ]);

      cache.clear();
      cronCache.clear();
      deviceTopics.clear();
      targets.clear();
      commandPrefixes.length = 0;
      scenarios.clear();

      for (const device of devices) {
        deviceTopics.set(device.id, device.state_topic);
        targets.set(device.id, commandTargetFromRow(device));
        const command = device.command_topic?.trim();
        if (command) commandPrefixes.push({ prefix: command, deviceId: device.id });
      }
      // Dal più specifico al più generico: `cmnd/luce/Dimmer` non deve essere
      // attribuito al dispositivo che possiede il topic `cmnd/luc`.
      commandPrefixes.sort((first, second) => second.prefix.length - first.prefix.length);

      for (const deviceId of [...activityByDevice.keys()]) {
        if (!targets.has(deviceId)) activityByDevice.delete(deviceId);
      }

      for (const row of scenarioRows) {
        scenarios.set(row.id, {
          id: row.id,
          label: row.name,
          steps: parseScenarioSteps(row.actions),
        });
      }

      const rules: ResolvedAutomation[] = [];
      for (const row of rows) {
        const rule = resolveAutomation(row, automationConfig);
        cache.set(rule.id, rule);
        rules.push(rule);
        if (rule.triggerType === 'time_cron' && rule.trigger) {
          try {
            cronCache.set(rule.id, parseCron((rule.trigger as TimeCronTriggerConfig).cron));
          } catch {
            // `resolveAutomation` l'ha già scartata: qui non può succedere.
          }
        }
        if (rule.invalidReason) {
          log?.warn(`automazioni: regola "${rule.name}" (${rule.id}) inerte · ${rule.invalidReason}`);
        }
      }

      // Le regole sparite non devono lasciare il proprio timestamp nella mappa
      // del cooldown: la cache è la fonte di verità.
      for (const ruleId of [...lastExecutionTimestamps.keys()]) {
        if (!cache.has(ruleId)) lastExecutionTimestamps.delete(ruleId);
      }

      const wanted = new Set<string>();
      for (const rule of rules) {
        if (rule.triggerType === 'mqtt_state' && rule.trigger) {
          wanted.add((rule.trigger as MqttStateTriggerConfig).topic);
        }
      }
      // Lo stato di ogni dispositivo serve alle condizioni `device_state`,
      // anche quando non è il trigger di nessuna regola.
      for (const topic of deviceTopics.values()) wanted.add(topic);
      if (automationConfig.presenceTopic) wanted.add(automationConfig.presenceTopic);

      // Il collegamento può non esistere ancora (motore costruito senza
      // `start()`): l'insieme dei topic resta comunque aggiornato, così le
      // sottoscrizioni partono corrette alla prima connessione.
      for (const topic of wanted) {
        if (subscribedTopics.has(topic)) continue;
        subscribedTopics.add(topic);
        link?.subscribe(topic);
      }
      for (const topic of [...subscribedTopics]) {
        if (wanted.has(topic)) continue;
        subscribedTopics.delete(topic);
        link?.unsubscribe(topic);
        states.delete(topic);
      }

      const active = rules.filter((rule) => rule.trigger !== null).length;
      log?.info(
        `automazioni: ${active}/${rules.length} regole attive · ${subscribedTopics.size} topic sottoscritti`,
      );
      return rules;
    },

    async tick(at = clock()) {
      const runs: Promise<AutomationRunResult | null>[] = [];

      for (const rule of cache.values()) {
        try {
          if (!rule.trigger) continue;
          if (rule.triggerType === 'time_cron') {
            const cron = cronCache.get(rule.id);
            if (!cron || !matchesCron(cron, at)) continue;
            const stamp = minuteStamp(at);
            if (lastCronFired.get(rule.id) === stamp) continue;
            lastCronFired.set(rule.id, stamp);
            runs.push(
              runExclusive(
                rule,
                `cron:${cron.expression}`,
                at,
                false,
                automationLockKey(rule.id),
                rule.throttleMs,
              ),
            );
            continue;
          }

          if (rule.triggerType === 'sun_event') {
            const trigger = rule.trigger as SunEventTriggerConfig;
            if (automationConfig.latitude === null || automationConfig.longitude === null) continue;
            const minutes = sunEventLocalMinutes(trigger.event, {
              latitude: automationConfig.latitude,
              longitude: automationConfig.longitude,
              at,
              offsetMinutes: trigger.offsetMinutes,
            });
            // Nei giorni di sole perenne o notte polare l'evento non esiste.
            if (minutes === null || minutes !== localMinuteOfDay(at)) continue;
            const stamp = `${dateKey(at)}:${trigger.event}`;
            if (lastSunFired.get(rule.id) === stamp) continue;
            lastSunFired.set(rule.id, stamp);
            runs.push(
              runExclusive(
                rule,
                `sun:${trigger.event}`,
                at,
                false,
                automationLockKey(rule.id),
                rule.throttleMs,
              ),
            );
          }
        } catch (error) {
          // Isolamento: un trigger malformato non ferma gli altri.
          log?.warn(
            `automazioni: trigger di ${rule.name} fallito: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      void cleanupLogsOncePerHour(at);
      const settled = await Promise.all(runs);
      return settled.filter((result): result is AutomationRunResult => result !== null);
    },

    async handleMessage(topic, payload) {
      states.set(topic, payload);
      if (automationConfig.presenceTopic && topic === automationConfig.presenceTopic) {
        presence = parsePresence(payload);
      }

      const at = clock();
      const runs: Promise<AutomationRunResult | null>[] = [];

      for (const rule of cache.values()) {
        if (!rule.isActive || rule.triggerType !== 'mqtt_state' || !rule.trigger) continue;
        const trigger = rule.trigger as MqttStateTriggerConfig;
        if (!topicMatches(trigger.topic, topic)) continue;

        const observed = extractPayloadValue(payload, trigger.payloadKey);
        if (!valueMatches(observed, trigger.expectedValue)) {
          // Il valore atteso è tornato "spento": il prossimo cambio tornerà a
          // contare come transizione.
          lastTriggerValues.delete(rule.id);
          continue;
        }

        const signature = `${trigger.payloadKey ?? ''}=${observed}`;
        if (lastTriggerValues.get(rule.id) === signature) continue;
        lastTriggerValues.set(rule.id, signature);

        runs.push(
          runExclusive(
            rule,
            `mqtt:${topic}`,
            at,
            false,
            automationLockKey(rule.id),
            rule.throttleMs,
          ),
        );
      }

      const settled = await Promise.all(runs);
      return settled.filter((result): result is AutomationRunResult => result !== null);
    },

    async runTest(id) {
      let rule = cache.get(id);
      if (!rule) {
        const row = await db.findAutomationById(id);
        if (row) rule = resolveAutomation(row, automationConfig);
      }
      if (!rule) {
        throw Object.assign(new Error('Automazione non trovata'), { code: 'NOT_FOUND' });
      }

      // Anche il test manuale passa dal lock: non deve sovrapporsi a
      // un'esecuzione reale sullo stesso relè. Non consuma il cooldown, che
      // riguarda solo i trigger automatici.
      let release: (() => void) | null = null;
      try {
        release = await engineLock.acquire(automationLockKey(rule.id), AUTOMATION_LOCK_TIMEOUT_MS);
        return await runRule(rule, 'test', clock(), true);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        log?.warn(`automazioni: test di ${rule.name} (${rule.id}) non eseguito · ${message}`);
        throw cause instanceof Error
          ? cause
          : Object.assign(new Error(message), { code: 'LOCK_TIMEOUT' });
      } finally {
        release?.();
      }
    },

    rules() {
      return [...cache.values()];
    },

    activity() {
      return [...activityByDevice.values()].sort((first, second) => second.at - first.at);
    },

    subscriptions() {
      return [...subscribedTopics];
    },

    start() {
      if (timer) return;
      link ??= createMqttLink(config.mqtt, {
        clientId: `wallos-automation-${process.pid}-${Math.random().toString(16).slice(2, 6)}`,
        log,
      });

      if (!messageHandlerBound) {
        messageHandlerBound = true;
        link.onMessage((topic, payload) => {
          void engine.handleMessage(topic, payload).catch((error: unknown) => {
            log?.warn(
              `automazioni: valutazione del messaggio ${topic} fallita: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        });
      }

      // Cache e sottoscrizioni prima del primo tick: un riavvio non deve
      // aspettare un minuto per riallinearsi al database.
      void engine.reload().catch((error: unknown) => {
        log?.warn(
          `automazioni: caricamento iniziale fallito: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

      void engine.tick().catch((error: unknown) => {
        log?.warn(
          `automazioni: primo tick fallito: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

      timer = setInterval(() => {
        // Un tick lento (database lento) non deve accumulare esecuzioni.
        if (tickRunning) return;
        tickRunning = true;
        void engine.tick()
          .catch((error: unknown) => {
            log?.warn(
              `automazioni: tick fallito: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(() => {
            tickRunning = false;
          });
      }, intervalMs);
      timer.unref?.();
      log?.info(`automazioni: motore avviato (tick ${Math.round(intervalMs / 1000)} s)`);
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const socket = link;
      link = null;
      if (socket) await socket.close();
    },
  };

  return engine;
}

/** Descrizione leggibile di un trigger, per log e diagnostica. */
export function describeAutomation(rule: ResolvedAutomation): string {
  const parts = [rule.name, `[${rule.triggerType}]`];
  if (!rule.trigger) return `${parts.join(' ')} · inerte (${rule.invalidReason ?? 'non valida'})`;
  if (rule.triggerType === 'mqtt_state') {
    const trigger = rule.trigger as MqttStateTriggerConfig;
    const expected = trigger.expectedValue === undefined ? 'qualsiasi valore' : String(trigger.expectedValue);
    parts.push(trigger.topic, `→ ${expected}`);
  } else if (rule.triggerType === 'time_cron') {
    parts.push((rule.trigger as TimeCronTriggerConfig).cron);
  } else {
    const trigger = rule.trigger as SunEventTriggerConfig;
    const offset = trigger.offsetMinutes ?? 0;
    parts.push(`${trigger.event} ${offset >= 0 ? '+' : ''}${offset} min`);
  }
  return parts.join(' ');
}
