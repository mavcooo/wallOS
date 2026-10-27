/**
 * Forme delle automazioni lato pannello: rispecchiano i DTO di
 * `server/routes/automations.ts` — il server resta l'unica fonte di verità,
 * qui non c'è nessuna logica di valutazione.
 */

export type AutomationTriggerType = 'mqtt_state' | 'time_cron' | 'sun_event';

export type SunEventName = 'sunrise' | 'sunset';

export interface MqttStateTriggerConfig {
  topic: string;
  payloadKey?: string;
  expectedValue?: string | number | boolean;
}

export interface TimeCronTriggerConfig {
  cron: string;
}

export interface SunEventTriggerConfig {
  event: SunEventName;
  offsetMinutes?: number;
}

export type AutomationTriggerConfig =
  | MqttStateTriggerConfig
  | TimeCronTriggerConfig
  | SunEventTriggerConfig;

export interface TimeRangeCondition {
  type: 'time_range';
  /** `HH:MM`; una fascia che scavalca la mezzanotte (23:00 → 06:00) è valida. */
  start: string;
  end: string;
}

export interface DeviceStateCondition {
  type: 'device_state';
  deviceId: string;
  expectedState: string;
}

export interface UserPresentCondition {
  type: 'user_present';
  requireHome: boolean;
}

export type AutomationCondition =
  | TimeRangeCondition
  | DeviceStateCondition
  | UserPresentCondition;

/** Comando MQTT diretto su un topic. */
export interface MqttAutomationAction {
  type: 'mqtt';
  topic: string;
  payload: string;
  delayMs?: number;
}

/** Esecuzione di uno scenario ("one-touch" del pannello) fatta dal motore. */
export interface ScenarioAutomationAction {
  type: 'scenario';
  scenarioId: string;
  delayMs?: number;
}

export type AutomationAction = MqttAutomationAction | ScenarioAutomationAction;

export type AutomationActionStatus = 'sent' | 'failed' | 'skipped';

/** Comando pubblicato (o scartato) durante un'esecuzione. */
export interface AutomationCommandOutcome {
  /** Assenti quando il passo è stato scartato prima di avere un comando. */
  topic?: string;
  payload?: string;
  deviceId?: string;
  status: AutomationActionStatus;
  error?: string;
  durationMs: number;
}

/**
 * Esito di un'azione: un comando MQTT (una voce in `commands`) o un intero
 * scenario. I log scritti prima degli scenari non hanno `type` né `commands`:
 * il pannello li rende ancora in forma piatta con `topic`/`payload`.
 */
export interface AutomationActionOutcome {
  type?: 'mqtt' | 'scenario';
  status: AutomationActionStatus;
  topic?: string;
  payload?: string;
  scenarioId?: string;
  scenarioLabel?: string;
  commands?: AutomationCommandOutcome[];
  error?: string;
  durationMs: number;
}

/** Esito registrato di un'esecuzione. */
export interface AutomationRun {
  at: number;
  triggerSource: string;
  conditionsMet: boolean;
  executionTimeMs: number;
  error: string | null;
  actions: AutomationActionOutcome[] | null;
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  triggerType: AutomationTriggerType;
  /** Forma dipendente da `triggerType`: la legge il builder del form. */
  triggerConfig: Record<string, unknown>;
  /** Primo gruppo di condizioni (AND). */
  conditions: AutomationCondition[];
  /** Altri gruppi: AND dentro il gruppo, OR fra i gruppi (e con `conditions`). */
  conditionGroups: AutomationCondition[][];
  actions: AutomationAction[];
  lastTriggeredAt: number | null;
  executionCount: number;
  createdAt: number;
  updatedAt: number;
  lastRun: AutomationRun | null;
  /** Motivo per cui la regola non può essere eseguita (`null` = eseguibile). */
  invalidReason: string | null;
  /** Sommario leggibile del trigger, calcolato dal server. */
  summary: string;
}

/** Corpo di POST/PUT: la stessa forma per creazione e modifica. */
export interface AutomationDraft {
  name: string;
  description: string | null;
  isActive: boolean;
  triggerType: AutomationTriggerType;
  triggerConfig: AutomationTriggerConfig;
  /** Primo gruppo di condizioni (AND). */
  conditions: AutomationCondition[];
  /** Altri gruppi di condizioni, in OR con il primo. */
  conditionGroups: AutomationCondition[][];
  actions: AutomationAction[];
}

export interface AutomationLogEntry {
  id: string;
  triggeredAt: number;
  triggerSource: string;
  conditionsMet: boolean;
  executionTimeMs: number;
  error: string | null;
  actions: AutomationActionOutcome[] | null;
}

export interface AutomationTestExecution {
  automationId: string;
  triggerSource: string;
  conditionsMet: boolean;
  executionTimeMs: number;
  error: string | null;
  actions: AutomationActionOutcome[];
}

/**
 * Ultimo comando inviato a un dispositivo, con l'automazione responsabile:
 * è ciò che il badge sulle card mostra quando la luce si accende "da sola".
 * Vive in memoria nel server, quindi si azzera a ogni riavvio del motore.
 */
export interface DeviceAutomationActivity {
  deviceId: string;
  automationId: string;
  automationName: string;
  triggerSource: string;
  scenarioId: string | null;
  scenarioLabel: string | null;
  topic: string;
  payload: string;
  /** Epoch in millisecondi dell'invio del comando. */
  at: number;
}
