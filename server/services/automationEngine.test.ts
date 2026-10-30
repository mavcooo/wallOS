import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import type { NewAutomationLog } from '../db.js';
import type { MqttLink } from '../mqttClient.js';
import type {
  AuthConfig,
  AutomationLogRow,
  AutomationRow,
  DeviceRow,
  ScenarioRow,
} from '../types.js';
import {
  createAutomationEngine,
  parseScenarioSteps,
  type AutomationDb,
  evaluateConditionGroups,
  evaluateConditions,
  evaluateTimeRange,
  extractPayloadValue,
  parsePresence,
  resolveAutomation,
  stateMatches,
  topicMatches,
  valueMatches,
} from './automationEngine.js';

import { sunEventLocalMinutes } from './sun.js';

/** Mercoledì 21 ottobre 2026, 23:30 locali. */
const NIGHT = new Date(2026, 9, 21, 23, 30, 0, 0);

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const MOTION_TOPIC = 'stat/sensore_soggiorno/MOTION';
const LIGHT_COMMAND = 'cmnd/light_corridoio/dimmer';
const PRESENCE_TOPIC = 'stat/presence/home';

function config(overrides: Record<string, string> = {}): AuthConfig {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: 'admin-password-123',
    ADMIN_PIN: '2468',
    KIOSK_PIN: '1234',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    AUTOMATION_LATITUDE: '41.9028',
    AUTOMATION_LONGITUDE: '12.4964',
    AUTOMATION_PRESENCE_TOPIC: PRESENCE_TOPIC,
    ...overrides,
  });
}

function rule(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: RULE_ID,
    name: 'Luce corridoio di notte',
    description: 'Movimento in soggiorno fra le 23:00 e le 06:00',
    is_active: true,
    trigger_type: 'mqtt_state',
    trigger_config: { topic: MOTION_TOPIC, payloadKey: 'occupancy', expectedValue: true },
    conditions: [{ type: 'time_range', start: '23:00', end: '06:00' }],
    condition_groups: [],
    actions: [{ type: 'mqtt', topic: LIGHT_COMMAND, payload: '10', delayMs: 0 }],
    last_triggered_at: null,
    execution_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function device(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'light_corridoio',
    room_id: 'corridoio',
    name: 'Luce corridoio',
    type: 'light',
    adapter: 'tasmota',
    model: null,
    state_topic: 'stat/light_corridoio/POWER',
    command_topic: 'cmnd/light_corridoio',
    availability_topic: null,
    field_map: null,
    stream_url: null,
    snapshot_url: null,
    stream_protocol: null,
    aspect_ratio: null,
    metadata: {},
    favorite: false,
    protected: false,
    display_order: 0,
    room_pin_position: { x: 50, y: 50 },
    ...overrides,
  };
}

function scenario(overrides: Partial<ScenarioRow> = {}): ScenarioRow {
  return {
    id: 'goodnight',
    name: 'Buonanotte',
    description: 'Spegne tutto',
    icon: 'moon',
    protected: false,
    actions: [
      { deviceId: 'light_corridoio', action: { type: 'power', on: false } },
      { deviceId: 'light_corridoio', action: { type: 'brightness', brightness: 8 }, delayMs: 20 },
    ],
    display_order: 0,
    ...overrides,
  };
}

function fakeDb(
  rows: AutomationRow[],
  devices: DeviceRow[] = [],
  scenarios: ScenarioRow[] = [],
) {
  const logs: NewAutomationLog[] = [];
  // `satisfies` conserva il tipo `Mock` dei singoli metodi, così i test
  // possono sovrascrivere una risposta senza perdere il controllo di tipo.
  const methods = {
    listActiveAutomations: vi.fn(async () => rows.filter((row) => row.is_active)),
    listDevices: vi.fn(async () => devices),
    listScenarios: vi.fn(async () => scenarios),
    findAutomationById: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
    insertAutomationLog: vi.fn(async (entry: NewAutomationLog): Promise<AutomationLogRow> => {
      logs.push(entry);
      return {
        id: logs.length,
        automation_id: entry.automationId,
        triggered_at: entry.triggeredAt ?? new Date(),
        trigger_source: entry.triggerSource,
        conditions_met: entry.conditionsMet,
        actions_executed: entry.actionsExecuted,
        execution_time_ms: entry.executionTimeMs,
        error_message: entry.errorMessage,
      };
    }),
    recordAutomationRun: vi.fn(async () => undefined),
    cleanupAutomationLogs: vi.fn(async () => 0),
  } satisfies AutomationDb;
  return { ...methods, logs };
}

function fakeLink(options: { enabled?: boolean; failOn?: string } = {}) {
  const published: { topic: string; payload: string }[] = [];
  const subscribed = new Set<string>();
  let handler: ((topic: string, payload: string) => void) | null = null;

  const link: MqttLink = {
    enabled: options.enabled ?? true,
    publish(topic, payload) {
      if (topic === options.failOn) throw new Error('broker rifiutato');
      if (link.enabled) published.push({ topic, payload });
      return link.enabled;
    },
    subscribe(topic) {
      subscribed.add(topic);
    },
    unsubscribe(topic) {
      subscribed.delete(topic);
    },
    onMessage(next) {
      handler = next;
    },
    close: async () => undefined,
  };

  return {
    published,
    subscribed,
    link,
    emit(topic: string, payload: string) {
      handler?.(topic, payload);
    },
  };
}

function engineFor(
  rows: AutomationRow[],
  options: {
    devices?: DeviceRow[];
    scenarios?: ScenarioRow[];
    now?: Date;
    configOverrides?: Record<string, string>;
    enabled?: boolean;
    failOn?: string;
  } = {},
) {
  const db = fakeDb(rows, options.devices ?? [], options.scenarios ?? []);
  const mqtt = fakeLink({ enabled: options.enabled ?? true, failOn: options.failOn });
  const engine = createAutomationEngine({
    db,
    config: config(options.configOverrides),
    link: mqtt.link,
    now: () => options.now ?? NIGHT,
  });
  return { db, mqtt, engine };
}

describe('topicMatches', () => {
  it('confronta topic concreti e wildcard', () => {
    expect(topicMatches('stat/sensore/MOTION', 'stat/sensore/MOTION')).toBe(true);
    expect(topicMatches('stat/+/MOTION', 'stat/sensore/MOTION')).toBe(true);
    expect(topicMatches('stat/+/MOTION', 'stat/cucina/sensore/MOTION')).toBe(false);
    expect(topicMatches('stat/sensore/MOTION', 'stat/sensore/POWER')).toBe(false);
    expect(topicMatches('stat/sensore/#', 'stat/sensore/MOTION/raw')).toBe(true);
    expect(topicMatches('stat/sensore/#', 'stat/altro')).toBe(false);
    expect(topicMatches('stat/sensore/MOTION', 'stat/sensore')).toBe(false);
  });
});

describe('valori dei payload', () => {
  it('estrae una proprietà dal JSON e altrimenti legge il payload grezzo', () => {
    expect(extractPayloadValue('{"occupancy":true}', 'occupancy')).toBe('true');
    expect(extractPayloadValue('{"occupancy":false}', 'occupancy')).toBe('false');
    expect(extractPayloadValue('{"other":1}', 'occupancy')).toBe('');
    expect(extractPayloadValue('ON', 'occupancy')).toBe('ON');
    expect(extractPayloadValue(' ON ')).toBe('ON');
  });

  it('accetta ON/on/1/true come lo stesso valore', () => {
    expect(valueMatches('ON', true)).toBe(true);
    expect(valueMatches('true', true)).toBe(true);
    expect(valueMatches('1', true)).toBe(true);
    expect(valueMatches('off', false)).toBe(true);
    expect(valueMatches('0', false)).toBe(true);
    expect(valueMatches('ON', 'OFF')).toBe(false);
    expect(valueMatches('21.5', 21.5)).toBe(true);
    expect(valueMatches('21.5', 20)).toBe(false);
    // Nessun valore atteso: qualunque payload non vuoto fa scattare il trigger.
    expect(valueMatches('qualcosa', undefined)).toBe(true);
    expect(valueMatches('', undefined)).toBe(false);
  });

  it('riconosce lo stato di un dispositivo anche dentro un payload JSON', () => {
    expect(stateMatches('OFF', 'OFF')).toBe(true);
    expect(stateMatches('{"POWER":"OFF"}', 'OFF')).toBe(false);
    expect(stateMatches('{"power":"off"}', 'OFF')).toBe(true);
    expect(stateMatches('{"state":"ON","brightness":10}', 'ON')).toBe(true);
    expect(stateMatches('{"brightness":10}', 'ON')).toBe(false);
    expect(stateMatches(undefined, 'OFF')).toBe(false);
  });

  it('legge la presenza da booleani, stringhe e JSON', () => {
    expect(parsePresence('ON')).toBe(true);
    expect(parsePresence('home')).toBe(true);
    expect(parsePresence('{"occupancy":true}')).toBe(true);
    expect(parsePresence('1')).toBe(true);
    expect(parsePresence('OFF')).toBe(false);
    expect(parsePresence('not_home')).toBe(false);
    expect(parsePresence('{"occupancy":false}')).toBe(false);
    expect(parsePresence('')).toBe(false);
  });
});

describe('evaluateTimeRange', () => {
  const at2300 = new Date(2026, 9, 21, 23, 0, 0, 0);
  const at0530 = new Date(2026, 9, 22, 5, 30, 0, 0);
  const at1200 = new Date(2026, 9, 21, 12, 0, 0, 0);

  it('gestisce la fascia che scavalca la mezzanotte', () => {
    expect(evaluateTimeRange('23:00', '06:00', at2300)).toBe(true);
    expect(evaluateTimeRange('23:00', '06:00', at0530)).toBe(true);
    expect(evaluateTimeRange('23:00', '06:00', at1200)).toBe(false);
  });

  it('l’estremo iniziale è incluso e quello finale escluso', () => {
    expect(evaluateTimeRange('07:00', '09:00', new Date(2026, 9, 21, 7, 0))).toBe(true);
    expect(evaluateTimeRange('07:00', '09:00', new Date(2026, 9, 21, 8, 59))).toBe(true);
    expect(evaluateTimeRange('07:00', '09:00', new Date(2026, 9, 21, 9, 0))).toBe(false);
  });

  it('start uguale a end vale la giornata intera', () => {
    expect(evaluateTimeRange('00:00', '00:00', at1200)).toBe(true);
  });
});

describe('evaluateConditions', () => {
  const base = { at: NIGHT, presence: true, stateOf: () => 'OFF' };

  it('applica tutte le condizioni in AND', () => {
    expect(
      evaluateConditions(
        [
          { type: 'time_range', start: '23:00', end: '06:00' },
          { type: 'user_present', requireHome: true },
          { type: 'device_state', deviceId: 'light_corridoio', expectedState: 'OFF' },
        ],
        base,
      ),
    ).toBe(true);

    expect(
      evaluateConditions([{ type: 'user_present', requireHome: false }], base),
    ).toBe(false);
  });

  it('un dato mancante non soddisfa la condizione', () => {
    expect(
      evaluateConditions([{ type: 'device_state', deviceId: 'ignoto', expectedState: 'OFF' }], {
        ...base,
        stateOf: () => undefined,
      }),
    ).toBe(false);
    expect(
      evaluateConditions([{ type: 'user_present', requireHome: true }], { ...base, presence: null }),
    ).toBe(false);
    expect(
      evaluateConditions([{ type: 'user_present', requireHome: false }], { ...base, presence: null }),
    ).toBe(false);
  });
});

describe('evaluateConditionGroups', () => {
  const night = { at: NIGHT, presence: true, stateOf: () => 'OFF' };
  const noon = { at: new Date(2026, 9, 21, 12, 0, 0, 0), presence: true, stateOf: () => 'OFF' };
  const timeRange = { type: 'time_range', start: '23:00', end: '06:00' } as const;

  it('basta un gruppo soddisfatto per far scattare la regola', () => {
    const groups = [[timeRange], [{ type: 'user_present', requireHome: true } as const]];

    expect(evaluateConditionGroups(groups, night)).toBe(true);
    // Di giorno la fascia oraria non vale, ma la presenza sì.
    expect(evaluateConditionGroups(groups, noon)).toBe(true);
    expect(evaluateConditionGroups(groups, { ...noon, presence: false })).toBe(false);
  });

  it('dentro il gruppo le condizioni restano in AND', () => {
    const groups = [
      [timeRange, { type: 'user_present', requireHome: true } as const],
      [{ type: 'device_state', deviceId: 'light_corridoio', expectedState: 'ON' } as const],
    ];

    // Fascia attiva ma casa vuota; nessun altro gruppo soddisfatto.
    expect(evaluateConditionGroups(groups, { ...night, presence: false })).toBe(false);
    // Il secondo gruppo è indipendente dalla fascia oraria.
    expect(
      evaluateConditionGroups(groups, { ...noon, presence: false, stateOf: () => 'ON' }),
    ).toBe(true);
  });

  it('senza gruppi la regola scatta, un gruppo vuoto viene ignorato', () => {
    expect(evaluateConditionGroups([], night)).toBe(true);
    expect(evaluateConditionGroups([[]], night)).toBe(true);
    expect(
      evaluateConditionGroups([[timeRange], []], { ...noon, presence: false }),
    ).toBe(false);
  });
});

describe('parseScenarioSteps', () => {
  it('accetta i passi validati in scrittura', () => {
    expect(
      parseScenarioSteps([
        { deviceId: 'light_corridoio', action: { type: 'brightness', brightness: 12 } },
        { deviceId: 'media_living', action: { type: 'source', source: 'HDMI 1' }, delayMs: 120 },
      ]),
    ).toEqual([
      { deviceId: 'light_corridoio', action: { type: 'brightness', brightness: 12 }, delayMs: 0 },
      { deviceId: 'media_living', action: { type: 'source', source: 'HDMI 1' }, delayMs: 120 },
    ]);
  });

  it('scarta i passi inutilizzabili invece di eseguirli a metà', () => {
    expect(parseScenarioSteps('boh')).toBeNull();
    expect(parseScenarioSteps([{ deviceId: '', action: { type: 'power', on: true } }])).toBeNull();
    expect(
      parseScenarioSteps([{ deviceId: 'x', action: { type: 'brightness', brightness: 'alta' } }]),
    ).toBeNull();
    expect(parseScenarioSteps([])).toEqual([]);
  });
});

describe('resolveAutomation', () => {
  const settings = config().automation;

  it('risolve una regola MQTT valida', () => {
    const resolved = resolveAutomation(rule(), settings);
    expect(resolved.invalidReason).toBeNull();
    expect(resolved.trigger).toEqual({
      topic: MOTION_TOPIC,
      payloadKey: 'occupancy',
      expectedValue: true,
    });
    expect(resolved.actions).toEqual([
      { type: 'mqtt', topic: LIGHT_COMMAND, payload: '10', delayMs: 0 },
    ]);
  });

  it('legge i gruppi di condizioni in OR', () => {
    const resolved = resolveAutomation(
      rule({
        conditions: [{ type: 'time_range', start: '23:00', end: '06:00' }],
        condition_groups: [
          [{ type: 'user_present', requireHome: true }],
          [{ type: 'device_state', deviceId: 'light_corridoio', expectedState: 'ON' }],
        ],
      }),
      settings,
    );

    expect(resolved.invalidReason).toBeNull();
    expect(resolved.conditionGroups).toEqual([
      [{ type: 'user_present', requireHome: true }],
      [{ type: 'device_state', deviceId: 'light_corridoio', expectedState: 'ON' }],
    ]);
  });

  it('un gruppo malformato rende la regola inerte', () => {
    expect(
      resolveAutomation(rule({ condition_groups: [{ type: 'boh' }] }), settings).invalidReason,
    ).toMatch(/Gruppo/);
    expect(
      resolveAutomation(rule({ condition_groups: [[{ type: 'boh' }]] }), settings).invalidReason,
    ).toMatch(/Gruppo/);
  });

  it('risolve le azioni scenario e le distingue dai comandi MQTT', () => {
    const resolved = resolveAutomation(
      rule({
        actions: [
          { type: 'mqtt', topic: LIGHT_COMMAND, payload: '10', delayMs: 0 },
          { type: 'scenario', scenarioId: 'goodnight', delayMs: 500 },
        ],
      }),
      settings,
    );

    expect(resolved.invalidReason).toBeNull();
    expect(resolved.actions).toEqual([
      { type: 'mqtt', topic: LIGHT_COMMAND, payload: '10', delayMs: 0 },
      { type: 'scenario', scenarioId: 'goodnight', delayMs: 500 },
    ]);
    expect(
      resolveAutomation(rule({ actions: [{ type: 'scenario', scenarioId: '' }] }), settings)
        .invalidReason,
    ).toMatch(/Azione/);
  });

  it('scarta le regole con trigger o azioni inutilizzabili senza lanciare', () => {
    expect(resolveAutomation(rule({ trigger_type: 'mqtt_state', trigger_config: {} }), settings).invalidReason).toMatch(/topic/);
    expect(resolveAutomation(rule({ trigger_type: 'time_cron', trigger_config: { cron: '0 23 * *' } }), settings).invalidReason).toMatch(/5 campi/);
    expect(resolveAutomation(rule({ trigger_type: 'time_cron', trigger_config: { cron: '99 23 * * *' } }), settings).invalidReason).toMatch(/minuto/);
    expect(resolveAutomation(rule({ trigger_type: 'sconosciuto' }), settings).invalidReason).toMatch(/sconosciuto/);
    expect(resolveAutomation(rule({ actions: [] }), settings).invalidReason).toMatch(/azioni/);
    expect(resolveAutomation(rule({ conditions: [{ type: 'boh' }] }), settings).invalidReason).toMatch(/Condizione/);
    expect(
      resolveAutomation(rule({ actions: [{ topic: '', payload: '1' }] }), settings).invalidReason,
    ).toMatch(/Azione/);
  });

  it('le regole solari restano inerti senza coordinate', () => {
    const noCoordinates = loadConfig({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
      ADMIN_PASSWORD: 'admin-password-123',
      ADMIN_PIN: '2468',
      KIOSK_PIN: '1234',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    });
    const resolved = resolveAutomation(
      rule({ trigger_type: 'sun_event', trigger_config: { event: 'sunset', offsetMinutes: -15 } }),
      noCoordinates.automation,
    );
    expect(resolved.trigger).toBeNull();
    expect(resolved.invalidReason).toMatch(/AUTOMATION_LATITUDE/);
  });
});

describe('motore · trigger MQTT', () => {
  it('esegue l’azione del criterio di accettazione entro 200 ms', async () => {
    const { engine, mqtt, db } = engineFor([rule()]);
    await engine.reload();

    const startedAt = Date.now();
    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    const elapsed = Date.now() - startedAt;

    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '10' }]);
    expect(elapsed).toBeLessThan(200);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      automationId: RULE_ID,
      triggerSource: `mqtt:${MOTION_TOPIC}`,
      conditionsMet: true,
      error: null,
    });
    expect(results[0]?.executionTimeMs).toBeLessThan(200);
    expect(db.recordAutomationRun).toHaveBeenCalledTimes(1);

    expect(db.logs).toHaveLength(1);
    expect(db.logs[0]).toMatchObject({
      automationId: RULE_ID,
      triggerSource: `mqtt:${MOTION_TOPIC}`,
      conditionsMet: true,
      errorMessage: null,
    });
    expect(db.logs[0]?.actionsExecuted).toEqual([
      expect.objectContaining({
        type: 'mqtt',
        status: 'sent',
        commands: [
          expect.objectContaining({ topic: LIGHT_COMMAND, payload: '10', status: 'sent' }),
        ],
      }),
    ]);
  });

  it('scatta sul cambio di stato, non su ogni ripetizione del payload', async () => {
    const { engine, mqtt } = engineFor([rule()]);
    await engine.reload();

    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(mqtt.published).toHaveLength(1);

    // Il sensore torna a riposo, poi rileva di nuovo: nuova transizione. La
    // finestra di deduplicazione (150 ms) deve essere trascorsa, altrimenti il
    // secondo comando viene soppresso come farebbe un burst reale.
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":false}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 160));
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toHaveLength(1);

    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":false}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toHaveLength(2);
  });

  it('un payload che non corrisponde al valore atteso non fa nulla', async () => {
    const { engine, mqtt, db } = engineFor([rule()]);
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":false}');
    await engine.handleMessage('stat/altro/MOTION', '{"occupancy":true}');

    expect(results).toEqual([]);
    expect(mqtt.published).toEqual([]);
    expect(db.logs).toEqual([]);
  });

  it('registra le condizioni non soddisfatte senza comandare nulla', async () => {
    // Il trigger scatta a mezzogiorno: la fascia 23:00-06:00 non è attiva.
    const { engine, mqtt, db } = engineFor([rule()], { now: new Date(2026, 9, 21, 12, 0, 0, 0) });
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(mqtt.published).toEqual([]);
    expect(results[0]).toMatchObject({ conditionsMet: false, actions: [] });
    expect(db.logs[0]).toMatchObject({ conditionsMet: false, errorMessage: null });
    expect(db.recordAutomationRun).not.toHaveBeenCalled();
  });

  it('valuta le condizioni sullo stato reale dei dispositivi e sulla presenza', async () => {
    const presenceRule = rule({
      conditions: [
        { type: 'user_present', requireHome: true },
        { type: 'device_state', deviceId: 'light_corridoio', expectedState: 'OFF' },
      ],
    });
    const { engine, mqtt } = engineFor([presenceRule], { devices: [device()] });
    await engine.reload();

    expect(engine.subscriptions()).toEqual(
      expect.arrayContaining([MOTION_TOPIC, 'stat/light_corridoio/POWER', PRESENCE_TOPIC]),
    );

    // Presenza e stato non ancora noti: la regola non scatta.
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toEqual([]);

    await engine.handleMessage(PRESENCE_TOPIC, '{"occupancy":true}');
    // La luce è accesa: la condizione device_state non è soddisfatta.
    await engine.handleMessage('stat/light_corridoio/POWER', 'ON');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":false}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toEqual([]);

    await engine.handleMessage('stat/light_corridoio/POWER', 'OFF');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":false}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '10' }]);
  });

  it('un errore su una regola non ferma le altre', async () => {
    const failing = rule({ id: OTHER_ID, name: 'Regola rotta' });
    const { engine, mqtt, db } = engineFor([failing, rule()], { failOn: LIGHT_COMMAND });
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.error !== null)).toBe(true);
    expect(mqtt.published).toEqual([]);
    expect(db.logs).toHaveLength(2);
    expect(db.logs.every((entry) => entry.errorMessage !== null)).toBe(true);
  });

  it('senza broker configurato i comandi risultano falliti e il log lo dice', async () => {
    const { engine, mqtt, db } = engineFor([rule()], { enabled: false });
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(mqtt.published).toEqual([]);
    expect(results[0]?.error).toMatch(/Broker MQTT/);
    expect(db.logs[0]?.actionsExecuted).toEqual([
      expect.objectContaining({
        type: 'mqtt',
        status: 'failed',
        commands: [
          expect.objectContaining({
            status: 'failed',
            error: 'Broker MQTT non configurato: comando non inviato',
          }),
        ],
      }),
    ]);
  });
});

describe('motore · azioni', () => {
  it('esegue le azioni in sequenza rispettando i ritardi', async () => {
    const { engine, mqtt } = engineFor([
      rule({
        conditions: [],
        actions: [
          { topic: LIGHT_COMMAND, payload: '10', delayMs: 0 },
          { topic: 'cmnd/relay_salotto/POWER', payload: 'OFF', delayMs: 30 },
        ],
      }),
    ]);
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(mqtt.published.map((entry) => entry.topic)).toEqual([
      LIGHT_COMMAND,
      'cmnd/relay_salotto/POWER',
    ]);
    expect(results[0]?.executionTimeMs).toBeGreaterThanOrEqual(25);
    expect(results[0]?.actions.map((action) => action.status)).toEqual(['sent', 'sent']);
  });
});

describe('motore · gruppi di condizioni in OR', () => {
  const daytime = new Date(2026, 9, 21, 12, 0, 0, 0);
  const overnight = () =>
    rule({
      conditions: [{ type: 'time_range', start: '23:00', end: '06:00' }],
      condition_groups: [[{ type: 'user_present', requireHome: true }]],
    });

  it('di giorno scatta il gruppo della presenza', async () => {
    const { engine, mqtt } = engineFor([overnight()], { now: daytime });
    await engine.reload();

    // Mezzogiorno: la fascia oraria non vale, ma qualcuno è in casa.
    await engine.handleMessage(PRESENCE_TOPIC, '{"occupancy":true}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '10' }]);

    // Casa vuota: nessuno dei due gruppi è soddisfatto.
    await engine.handleMessage(PRESENCE_TOPIC, '{"occupancy":false}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":false}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toHaveLength(1);
  });

  it('di notte basta la fascia oraria, anche a casa vuota', async () => {
    const { engine, mqtt } = engineFor([overnight()]);
    await engine.reload();

    await engine.handleMessage(PRESENCE_TOPIC, '{"occupancy":false}');
    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '10' }]);
  });

  it('il primo gruppo resta il comportamento di sempre quando è l’unico', async () => {
    const { engine, mqtt } = engineFor([rule()], { now: daytime });
    await engine.reload();

    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(mqtt.published).toEqual([]);
  });
});

describe('motore · azioni scenario', () => {
  const scenarioRule = () =>
    rule({ conditions: [], actions: [{ type: 'scenario', scenarioId: 'goodnight', delayMs: 0 }] });

  it('traduce i passi nei comandi del device e li registra nel log', async () => {
    const { engine, mqtt, db } = engineFor([scenarioRule()], {
      devices: [device()],
      scenarios: [scenario()],
    });
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(mqtt.published).toEqual([
      { topic: 'cmnd/light_corridoio/POWER', payload: 'OFF' },
      { topic: 'cmnd/light_corridoio/Dimmer', payload: '8' },
    ]);
    expect(results[0]?.actions).toEqual([
      expect.objectContaining({
        type: 'scenario',
        status: 'sent',
        scenarioId: 'goodnight',
        scenarioLabel: 'Buonanotte',
        commands: [
          expect.objectContaining({
            topic: 'cmnd/light_corridoio/POWER',
            status: 'sent',
            deviceId: 'light_corridoio',
          }),
          expect.objectContaining({
            topic: 'cmnd/light_corridoio/Dimmer',
            status: 'sent',
            deviceId: 'light_corridoio',
          }),
        ],
      }),
    ]);
    expect(results[0]?.error).toBeNull();
    expect(db.logs[0]?.actionsExecuted).toEqual(results[0]?.actions);
  });

  it('salta i passi non eseguibili senza far fallire lo scenario', async () => {
    const sensor = device({
      id: 'sensore_movimento',
      name: 'Sensore corridoio',
      type: 'sensor',
      adapter: 'zigbee2mqtt',
      command_topic: null,
      state_topic: 'stat/sensore_corridoio',
    });
    const mixed = scenario({
      actions: [
        { deviceId: 'sensore_movimento', action: { type: 'power', on: true } },
        { deviceId: 'sparito', action: { type: 'power', on: true } },
        { deviceId: 'light_corridoio', action: { type: 'power', on: true } },
      ],
    });
    const { engine, mqtt } = engineFor([scenarioRule()], {
      devices: [sensor, device()],
      scenarios: [mixed],
    });
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    const action = results[0]?.actions[0];

    expect(mqtt.published).toEqual([{ topic: 'cmnd/light_corridoio/POWER', payload: 'ON' }]);
    expect(action?.status).toBe('sent');
    expect(action?.commands?.map((command) => command.status)).toEqual([
      'skipped',
      'skipped',
      'sent',
    ]);
    expect(action?.commands?.[0]?.error).toMatch(/topic di comando/);
    expect(action?.commands?.[1]?.error).toMatch(/anagrafica/);
    expect(results[0]?.error).toBeNull();
  });

  it('uno scenario sparito fallisce senza fermare le azioni successive', async () => {
    const { engine, mqtt } = engineFor([
      rule({
        conditions: [],
        actions: [
          { type: 'scenario', scenarioId: 'sparito' },
          { type: 'mqtt', topic: LIGHT_COMMAND, payload: '10' },
        ],
      }),
    ]);
    await engine.reload();

    const results = await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(results[0]?.error).toMatch(/sparito/);
    expect(results[0]?.actions.map((action) => action.status)).toEqual(['failed', 'sent']);
    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '10' }]);
  });
});

describe('motore · attività per device', () => {
  it('dichiara quale automazione ha comandato un dispositivo', async () => {
    const { engine } = engineFor([rule({ conditions: [] })], { devices: [device()] });
    await engine.reload();
    expect(engine.activity()).toEqual([]);

    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');

    expect(engine.activity()).toEqual([
      expect.objectContaining({
        deviceId: 'light_corridoio',
        automationId: RULE_ID,
        automationName: 'Luce corridoio di notte',
        triggerSource: `mqtt:${MOTION_TOPIC}`,
        scenarioId: null,
        scenarioLabel: null,
        topic: LIGHT_COMMAND,
        payload: '10',
      }),
    ]);
  });

  it('attribuisce ai device dello scenario e dimentica quelli spariti', async () => {
    const db = fakeDb(
      [rule({ conditions: [], actions: [{ type: 'scenario', scenarioId: 'goodnight' }] })],
      [device()],
      [scenario()],
    );
    const mqtt = fakeLink();
    const engine = createAutomationEngine({
      db,
      config: config(),
      link: mqtt.link,
      now: () => NIGHT,
    });
    await engine.reload();

    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(engine.activity()).toEqual([
      expect.objectContaining({ scenarioId: 'goodnight', scenarioLabel: 'Buonanotte' }),
    ]);

    // Il device viene tolto dall'anagrafica: il badge non deve restare orfano.
    db.listDevices.mockResolvedValue([]);
    await engine.reload();
    expect(engine.activity()).toEqual([]);
  });

  it('un comando non inviato non compare nell’attività', async () => {
    const { engine } = engineFor([rule({ conditions: [] })], {
      devices: [device()],
      enabled: false,
    });
    await engine.reload();

    await engine.handleMessage(MOTION_TOPIC, '{"occupancy":true}');
    expect(engine.activity()).toEqual([]);
  });
});

describe('motore · trigger temporali', () => {
  it('il cron scatta una volta sola nel minuto', async () => {
    const at = new Date(2026, 9, 21, 23, 0, 0, 0);
    const { engine, mqtt } = engineFor(
      [
        rule({
          trigger_type: 'time_cron',
          trigger_config: { cron: '0 23 * * *' },
          conditions: [],
          actions: [{ topic: 'cmnd/relay_salotto/POWER', payload: 'OFF', delayMs: 0 }],
        }),
      ],
      { now: at },
    );
    await engine.reload();

    await engine.tick(at);
    await engine.tick(new Date(2026, 9, 21, 23, 0, 45, 0));
    expect(mqtt.published).toHaveLength(1);

    // Minuto diverso: il trigger non corrisponde all'espressione.
    await engine.tick(new Date(2026, 9, 21, 23, 1, 0, 0));
    expect(mqtt.published).toHaveLength(1);
  });

  it('il tramonto scatta al minuto calcolato, con lo sfasamento', async () => {
    const day = new Date(2026, 9, 21, 12, 0, 0, 0);
    const sunsetMinutes = sunEventLocalMinutes('sunset', {
      latitude: 41.9028,
      longitude: 12.4964,
      at: day,
      offsetMinutes: -15,
    }) as number;
    const fireAt = new Date(2026, 9, 21, Math.floor(sunsetMinutes / 60), sunsetMinutes % 60, 0, 0);

    const { engine, mqtt } = engineFor(
      [
        rule({
          trigger_type: 'sun_event',
          trigger_config: { event: 'sunset', offsetMinutes: -15 },
          conditions: [],
          actions: [{ topic: LIGHT_COMMAND, payload: '30', delayMs: 0 }],
        }),
      ],
      { now: fireAt },
    );
    await engine.reload();

    await engine.tick(fireAt);
    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '30' }]);

    // Stesso giorno, minuto successivo: nessun secondo scatto.
    await engine.tick(new Date(fireAt.getTime() + 60_000));
    expect(mqtt.published).toHaveLength(1);

    // Un'ora prima il tramonto non è ancora arrivato.
    const earlier = new Date(fireAt.getTime() - 60 * 60_000);
    await engine.tick(earlier);
    expect(mqtt.published).toHaveLength(1);
  });

  it('le regole solari senza coordinate restano inerti e vengono segnalate', async () => {
    const at = new Date(2026, 9, 21, 12, 0, 0, 0);
    const { engine, mqtt } = engineFor(
      [
        rule({
          trigger_type: 'sun_event',
          trigger_config: { event: 'sunset', offsetMinutes: 0 },
          conditions: [],
          actions: [{ topic: LIGHT_COMMAND, payload: '30', delayMs: 0 }],
        }),
      ],
      { now: at, configOverrides: { AUTOMATION_LATITUDE: '', AUTOMATION_LONGITUDE: '' } },
    );

    const rules = await engine.reload();
    expect(rules[0]?.invalidReason).toMatch(/AUTOMATION_LATITUDE/);

    await engine.tick(at);
    expect(mqtt.published).toEqual([]);
  });
});

describe('motore · esecuzione di prova e cache', () => {
  it('il test ignora le condizioni ma non conta come trigger reale', async () => {
    const { engine, mqtt, db } = engineFor([rule()], { now: new Date(2026, 9, 21, 12, 0, 0, 0) });
    await engine.reload();

    const result = await engine.runTest(RULE_ID);

    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '10' }]);
    expect(result.triggerSource).toBe('test');
    expect(result.conditionsMet).toBe(true);
    expect(db.recordAutomationRun).not.toHaveBeenCalled();
    expect(db.logs[0]?.triggerSource).toBe('test');
  });

  it('il test funziona anche su una regola disattivata', async () => {
    const inactive = rule({ is_active: false });
    const { engine, mqtt } = engineFor([inactive]);
    await engine.reload();
    expect(engine.rules()).toEqual([]);

    await engine.runTest(RULE_ID);
    expect(mqtt.published).toEqual([{ topic: LIGHT_COMMAND, payload: '10' }]);
  });

  it('il test di un id inesistente fallisce', async () => {
    const { engine } = engineFor([rule()]);
    await engine.reload();
    await expect(engine.runTest('33333333-3333-4333-8333-333333333333')).rejects.toThrow(
      /non trovata/,
    );
  });

  it('ricarica la cache e riallinea le sottoscrizioni MQTT', async () => {
    const db = fakeDb([rule()]);
    const mqtt = fakeLink();
    const engine = createAutomationEngine({
      db,
      config: config(),
      link: mqtt.link,
      now: () => NIGHT,
    });

    await engine.reload();
    expect(mqtt.subscribed.has(MOTION_TOPIC)).toBe(true);

    // La regola cambia topic: il vecchio viene lasciato.
    db.listActiveAutomations.mockResolvedValue([
      rule({ trigger_config: { topic: 'stat/sensore_cucina/MOTION', payloadKey: 'occupancy', expectedValue: true } }),
    ]);
    await engine.reload();

    expect(mqtt.subscribed.has('stat/sensore_cucina/MOTION')).toBe(true);
    expect(mqtt.subscribed.has(MOTION_TOPIC)).toBe(false);
    expect(engine.subscriptions()).toEqual(['stat/sensore_cucina/MOTION', PRESENCE_TOPIC].sort((a, b) => a.localeCompare(b)));
  });

  it('una regola disattivata non viene caricata né sottoscritta', async () => {
    const db = fakeDb([rule({ is_active: false })]);
    const mqtt = fakeLink();
    const engine = createAutomationEngine({
      db,
      config: config(),
      link: mqtt.link,
      now: () => NIGHT,
    });

    await engine.reload();

    expect(engine.rules()).toEqual([]);
    expect(mqtt.subscribed.has(MOTION_TOPIC)).toBe(false);
    expect(mqtt.subscribed.has(PRESENCE_TOPIC)).toBe(true);
  });
});
