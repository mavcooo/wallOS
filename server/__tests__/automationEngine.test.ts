import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import type { NewAutomationLog } from '../db.js';
import type { MqttLink } from '../mqttClient.js';
import type { AuthConfig, AutomationLogRow, AutomationRow, DeviceRow } from '../types.js';
import {
  automationLockKey,
  createAutomationEngine,
  DEFAULT_AUTOMATION_THROTTLE_MS,
  MAX_AUTOMATION_THROTTLE_MS,
  resolveAutomation,
  type AutomationDb,
} from '../services/automationEngine.js';
import { KeyedAsyncLock } from '../utils/keyedAsyncLock.js';

/**
 * Suite di concorrenza del motore: i casi che nella pratica facevano scattare
 * due volte lo stesso relè (TOCTOU fra valutazioni concorrenti, rilascio del
 * lock su un ramo d'errore, isolamento fra dispositivi diversi).
 */

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const PIR_RULE_ID = '22222222-2222-4222-8222-222222222222';
const POWER_TOPIC = 'tele/misuratore/SENSOR';
const PIR_TOPIC = 'stat/pir_garage/MOTION';
const RELAY_COMMAND = 'cmnd/relay_boiler/POWER';
const LIGHT_COMMAND = 'cmnd/luce_garage/POWER';
const RELAY_KEY = automationLockKey(RULE_ID);

function config(): AuthConfig {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-with-enough-entropy-0123456789abcdef',
    ADMIN_PASSWORD: 'admin-password-123',
    ADMIN_PIN: '2468',
    KIOSK_PIN: '1234',
    BCRYPT_ROUNDS: '4',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  });
}

/** Regola sul misuratore di potenza: scatta su qualunque lettura pubblicata. */
function powerRule(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: RULE_ID,
    name: 'Boiler a pieno carico',
    description: 'Letture di potenza oltre la soglia nominale',
    is_active: true,
    trigger_type: 'mqtt_state',
    trigger_config: { topic: POWER_TOPIC, payloadKey: 'powerWatts' },
    conditions: [],
    condition_groups: [],
    actions: [{ type: 'mqtt', topic: RELAY_COMMAND, payload: 'OFF', delayMs: 0 }],
    last_triggered_at: null,
    execution_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Seconda regola, su un altro dispositivo: deve restare indipendente. */
function pirRule(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    ...powerRule(),
    id: PIR_RULE_ID,
    name: 'Luce garage su movimento',
    trigger_config: { topic: PIR_TOPIC, payloadKey: 'occupancy', expectedValue: true },
    actions: [{ type: 'mqtt', topic: LIGHT_COMMAND, payload: 'ON', delayMs: 120 }],
    ...overrides,
  };
}

function device(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'relay_boiler',
    room_id: 'garage',
    name: 'Relè boiler',
    type: 'power',
    adapter: 'tasmota',
    model: null,
    state_topic: POWER_TOPIC,
    command_topic: 'cmnd/relay_boiler',
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

const PIR_DEVICE = device({
  id: 'pir_garage',
  name: 'PIR garage',
  type: 'sensor',
  adapter: 'zigbee2mqtt',
  state_topic: PIR_TOPIC,
  command_topic: null,
});

function fakeDb(rows: AutomationRow[]) {
  const logs: NewAutomationLog[] = [];
  const methods = {
    listActiveAutomations: vi.fn(async () => rows.filter((row) => row.is_active)),
    listDevices: vi.fn(async () => [device(), PIR_DEVICE]),
    listScenarios: vi.fn(async () => []),
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

/** Link finto che conta i tentativi di publish e può farli fallire. */
function fakeLink(options: { failOn?: string } = {}) {
  const published: { topic: string; payload: string }[] = [];
  let attempts = 0;

  const link: MqttLink = {
    enabled: true,
    publish(topic, payload) {
      attempts += 1;
      if (topic === options.failOn) throw new Error('broker rifiutato');
      published.push({ topic, payload });
      return true;
    },
    subscribe() {},
    unsubscribe() {},
    onMessage() {},
    close: async () => undefined,
  };

  return {
    link,
    published,
    attempts: () => attempts,
  };
}

function engineFor(rows: AutomationRow[], options: { failOn?: string; lock?: KeyedAsyncLock } = {}) {
  const db = fakeDb(rows);
  const mqtt = fakeLink({ failOn: options.failOn });
  const lock = options.lock ?? new KeyedAsyncLock();
  const engine = createAutomationEngine({
    db,
    config: config(),
    link: mqtt.link,
    lock,
    now: () => new Date(2026, 9, 21, 23, 30, 0, 0),
  });
  return { db, mqtt, lock, engine };
}

/** Attesa reale: il cooldown si misura su `Date.now()`, non sull'orologio iniettato. */
function afterCooldown(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, DEFAULT_AUTOMATION_THROTTLE_MS + 20));
}

describe('KeyedAsyncLock', () => {
  it('serializza la stessa chiave e serve i risvegli in ordine di arrivo', async () => {
    const lock = new KeyedAsyncLock();
    const order: string[] = [];

    const firstRelease = await lock.acquire('device');
    expect(lock.isLocked('device')).toBe(true);

    const second = lock.acquire('device').then((release) => {
      order.push('second');
      return release;
    });
    const third = lock.acquire('device').then((release) => {
      order.push('third');
      return release;
    });
    expect(lock.pending('device')).toBe(2);

    firstRelease();
    const secondRelease = await second;
    // Il primo rilascio passa la chiave al secondo senza mai liberarla: chi
    // arriva dopo non può scavalcare la coda.
    expect(order).toEqual(['second']);
    expect(lock.isLocked('device')).toBe(true);

    secondRelease();
    const thirdRelease = await third;
    expect(order).toEqual(['second', 'third']);

    thirdRelease();
    expect(lock.isLocked('device')).toBe(false);
    expect(lock.pending('device')).toBe(0);
  });

  it('chiavi diverse procedono in parallelo', async () => {
    const lock = new KeyedAsyncLock();

    const releaseA = await lock.acquire('device_A', 50);
    const releaseB = await lock.acquire('device_B', 50);

    expect(lock.isLocked('device_A')).toBe(true);
    expect(lock.isLocked('device_B')).toBe(true);

    releaseA();
    releaseB();
    expect(lock.keys()).toEqual([]);
  });

  it('va in timeout, esce dalla coda e lascia la chiave al detentore', async () => {
    const lock = new KeyedAsyncLock();
    const release = await lock.acquire('k');

    const waiting = lock.acquire('k', 20);
    await expect(waiting).rejects.toThrow(/Timeout \[20ms\]/);
    expect(lock.pending('k')).toBe(0);
    expect(lock.isLocked('k')).toBe(true);

    release();
    expect(lock.isLocked('k')).toBe(false);

    // La chiave resta utilizzabile dopo un timeout.
    const again = await lock.acquire('k', 20);
    again();
    expect(lock.isLocked('k')).toBe(false);
  });

  it('il rilascio è idempotente e non libera il lock di un altro detentore', async () => {
    const lock = new KeyedAsyncLock();
    const firstRelease = await lock.acquire('k');
    const secondPromise = lock.acquire('k');

    firstRelease();
    firstRelease();
    const secondRelease = await secondPromise;
    expect(lock.isLocked('k')).toBe(true);

    secondRelease();
    secondRelease();
    expect(lock.isLocked('k')).toBe(false);
  });
});

describe('automationEngine · concorrenza', () => {
  it('20 messaggi simultanei sullo stesso dispositivo comandano il relè una sola volta', async () => {
    const { engine, mqtt, db, lock } = engineFor([powerRule()]);
    await engine.reload();

    // Burst realistico: il misuratore pubblica 20 letture sopra soglia, tutte
    // diverse fra loro (quindi l'edge-triggering da solo non le filtra).
    const payloads = Array.from({ length: 20 }, (_, index) =>
      JSON.stringify({ powerWatts: 2_100 + index }),
    );

    const results = await Promise.all(
      payloads.map((payload) => engine.handleMessage(POWER_TOPIC, payload)),
    );
    const executed = results.flat();

    expect(mqtt.published).toEqual([{ topic: RELAY_COMMAND, payload: 'OFF' }]);
    expect(mqtt.attempts()).toBe(1);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ automationId: RULE_ID, conditionsMet: true, error: null });
    expect(db.logs).toHaveLength(1);
    expect(db.recordAutomationRun).toHaveBeenCalledTimes(1);

    // Il lock è tornato libero: nessuna promessa rimasta appesa.
    expect(lock.pending(RELAY_KEY)).toBe(0);
    expect(lock.isLocked(RELAY_KEY)).toBe(false);
  });

  it('la soppressione è temporale: a cooldown scaduto il trigger successivo esegue', async () => {
    const { engine, mqtt } = engineFor([powerRule()]);
    await engine.reload();

    await engine.handleMessage(POWER_TOPIC, '{"powerWatts":2100}');
    await engine.handleMessage(POWER_TOPIC, '{"powerWatts":2400}');
    expect(mqtt.published).toHaveLength(1);

    await afterCooldown();
    const results = await engine.handleMessage(POWER_TOPIC, '{"powerWatts":2600}');

    expect(results).toHaveLength(1);
    expect(mqtt.published).toHaveLength(2);
  });

  it('rilascia il lock quando un’azione lancia un errore e non resta bloccato', async () => {
    const { engine, mqtt, db, lock } = engineFor([powerRule()], { failOn: RELAY_COMMAND });
    await engine.reload();

    const results = await engine.handleMessage(POWER_TOPIC, '{"powerWatts":2100}');

    expect(results[0]?.error).toMatch(/broker rifiutato/);
    expect(mqtt.attempts()).toBe(1);
    expect(lock.isLocked(RELAY_KEY)).toBe(false);
    expect(lock.pending(RELAY_KEY)).toBe(0);

    // Il messaggio successivo non trova un lock orfano: la regola riprova.
    await afterCooldown();
    await engine.handleMessage(POWER_TOPIC, '{"powerWatts":2500}');
    expect(mqtt.attempts()).toBe(2);
    expect(db.logs).toHaveLength(2);
    expect(lock.isLocked(RELAY_KEY)).toBe(false);
  });

  it('chiavi eterogenee procedono in parallelo senza bloccarsi a vicenda', async () => {
    const { engine, mqtt } = engineFor([powerRule(), pirRule()]);
    await engine.reload();

    const startedAt = Date.now();
    const [powerRun, pirRun] = await Promise.all([
      engine.handleMessage(POWER_TOPIC, '{"powerWatts":2100}'),
      engine.handleMessage(PIR_TOPIC, '{"occupancy":true}'),
    ]);
    const elapsed = Date.now() - startedAt;

    expect(powerRun[0]?.error).toBeNull();
    // L'azione del PIR attende 120 ms: se le due chiavi si serializzassero
    // l'attesa raddoppierebbe.
    expect(pirRun[0]?.error).toBeNull();
    expect(mqtt.published.map((entry) => entry.topic).sort()).toEqual(
      [LIGHT_COMMAND, RELAY_COMMAND].sort(),
    );
    expect(elapsed).toBeLessThan(230);
  });

  it('throttle_ms: 0 disabilita la deduplicazione per quella regola', async () => {
    const { engine, mqtt } = engineFor([powerRule({ throttle_ms: 0 })]);
    await engine.reload();

    await engine.handleMessage(POWER_TOPIC, '{"powerWatts":2100}');
    await engine.handleMessage(POWER_TOPIC, '{"powerWatts":2200}');

    expect(mqtt.published).toHaveLength(2);
  });

  it('normalizza throttle_ms fra default, zero e tetto massimo', () => {
    const settings = config().automation;

    expect(resolveAutomation(powerRule(), settings).throttleMs).toBe(
      DEFAULT_AUTOMATION_THROTTLE_MS,
    );
    expect(resolveAutomation(powerRule({ throttle_ms: 900 }), settings).throttleMs).toBe(900);
    expect(resolveAutomation(powerRule({ throttle_ms: 0 }), settings).throttleMs).toBe(0);
    expect(resolveAutomation(powerRule({ throttle_ms: null }), settings).throttleMs).toBe(
      DEFAULT_AUTOMATION_THROTTLE_MS,
    );
    expect(resolveAutomation(powerRule({ throttle_ms: -5 }), settings).throttleMs).toBe(
      DEFAULT_AUTOMATION_THROTTLE_MS,
    );
    expect(
      resolveAutomation(powerRule({ throttle_ms: MAX_AUTOMATION_THROTTLE_MS * 10 }), settings)
        .throttleMs,
    ).toBe(MAX_AUTOMATION_THROTTLE_MS);
    expect(resolveAutomation(powerRule({ throttle_ms: Number.NaN }), settings).throttleMs).toBe(
      DEFAULT_AUTOMATION_THROTTLE_MS,
    );
  });
});
