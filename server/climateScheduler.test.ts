import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from './db.js';
import {
  buildClimateCommands,
  createClimateScheduler,
  createMqttClimatePublisher,
  normalizeWindows,
  nextWindowStart,
  planClimateDevice,
  PUBLISH_ACK_TIMEOUT_MS,
  resolveActiveWindow,
  timeOfMinutes,
  type ClimatePublisher,
} from './services/climateScheduler.js';
import type { AuthConfig, ClimateRuntimeRow, ClimateScheduleRow, DeviceRow } from './types.js';

// Broker finto: `publish` non chiama mai il callback da solo, così i test
// controllano quando (e se) arriva il PUBACK.
const mqttMock = vi.hoisted(() => {
  const socket = {
    on: vi.fn(),
    publish: vi.fn(),
    end: vi.fn(),
  };
  return { socket, connect: vi.fn(() => socket) };
});

vi.mock('mqtt', () => ({ default: { connect: mqttMock.connect } }));

/** Mercoledì 21 ottobre 2026, 12:00 locali (0 = domenica → 3 = mercoledì). */
const WEDNESDAY_NOON = new Date(2026, 9, 21, 12, 0, 0, 0);

function device(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'climate-living',
    room_id: 'living',
    name: 'Termostato soggiorno',
    type: 'climate',
    adapter: 'zigbee2mqtt',
    model: null,
    state_topic: 'zigbee2mqtt/living/thermostat',
    command_topic: 'zigbee2mqtt/living/thermostat/set',
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

function runtime(overrides: Partial<ClimateRuntimeRow> = {}): ClimateRuntimeRow {
  return {
    device_id: 'climate-living',
    override_target_temp: null,
    override_hvac_mode: null,
    override_until: null,
    vacation_mode: false,
    vacation_until: null,
    last_sent_target_temp: null,
    last_sent_hvac_mode: null,
    last_sent_at: null,
    updated_at: new Date(),
    ...overrides,
  };
}

let sequence = 0;
function schedule(overrides: Partial<ClimateScheduleRow> = {}): ClimateScheduleRow {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    device_id: 'climate-living',
    day_of_week: 3,
    start_time: '06:00:00',
    end_time: '08:00:00',
    target_temp: '20.5',
    hvac_mode: 'comfort',
    is_active: true,
    ...overrides,
  };
}

describe('normalizeWindows', () => {
  it('scarta le fasce disattivate e gli orari incoerenti', () => {
    const windows = normalizeWindows([
      schedule(),
      schedule({ is_active: false }),
      schedule({ start_time: '10:00:00', end_time: '09:00:00' }),
    ]);

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ dayOfWeek: 3, startMinute: 360, endMinute: 480 });
    expect(windows[0]?.targetTemp).toBe(20.5);
  });

  it('legge 24:00 come fine giornata', () => {
    const windows = normalizeWindows([
      schedule({ day_of_week: 0, start_time: '00:00:00', end_time: '24:00:00' }),
    ]);
    expect(windows[0]?.endMinute).toBe(1440);
    expect(timeOfMinutes(1440)).toBe('24:00');
  });
});

describe('resolveActiveWindow', () => {
  const windows = normalizeWindows([schedule()]);

  it('trova la fascia che contiene l’istante', () => {
    expect(resolveActiveWindow(windows, new Date(2026, 9, 21, 7, 30))).not.toBeNull();
    expect(resolveActiveWindow(windows, new Date(2026, 9, 21, 6, 0))).not.toBeNull();
  });

  it('la fine della fascia è esclusa e conta il giorno della settimana', () => {
    expect(resolveActiveWindow(windows, new Date(2026, 9, 21, 8, 0))).toBeNull();
    // Giovedì alla stessa ora: la fascia è solo del mercoledì.
    expect(resolveActiveWindow(windows, new Date(2026, 9, 22, 7, 0))).toBeNull();
  });
});

describe('nextWindowStart', () => {
  it('privilegia il cambio orario di oggi', () => {
    const windows = normalizeWindows([schedule({ start_time: '18:00:00', end_time: '22:00:00' })]);
    const next = nextWindowStart(windows, WEDNESDAY_NOON);

    expect(next?.at.getDay()).toBe(3);
    expect(next?.at.getHours()).toBe(18);
    expect(next?.at.getMinutes()).toBe(0);
  });

  it('salta alla settimana successiva se il programma di oggi è già passato', () => {
    const windows = normalizeWindows([schedule()]);
    const next = nextWindowStart(windows, WEDNESDAY_NOON);

    expect(next?.at.getTime()).toBe(new Date(2026, 9, 28, 6, 0, 0, 0).getTime());
  });

  it('senza fasce non c’è un prossimo cambio', () => {
    expect(nextWindowStart([], WEDNESDAY_NOON)).toBeNull();
  });
});

describe('buildClimateCommands', () => {
  it('Zigbee2MQTT riceve setpoint e modalità nel payload dell’adapter', () => {
    const [command] = buildClimateCommands(device(), { temp: 21, preset: 'comfort' });

    expect(command?.topic).toBe('zigbee2mqtt/living/thermostat/set');
    expect(JSON.parse(command?.payload ?? '{}')).toEqual({
      system_mode: 'heat',
      occupied_heating_setpoint: 21,
    });
  });

  it('la fascia off spegne il firmware senza setpoint', () => {
    const [command] = buildClimateCommands(device(), { temp: null, preset: 'off' });
    expect(JSON.parse(command?.payload ?? '{}')).toEqual({ system_mode: 'off' });
  });

  it('Tasmota usa topic separati per setpoint e modalità', () => {
    const commands = buildClimateCommands(device({ adapter: 'tasmota' }), {
      temp: 19.5,
      preset: 'eco',
    });

    expect(commands.map((command) => command.topic)).toEqual([
      'zigbee2mqtt/living/thermostat/set/Setpoint',
      'zigbee2mqtt/living/thermostat/set/Mode',
    ]);
    expect(commands.map((command) => command.payload)).toEqual(['19.5', 'heat']);
  });

  it('il JSON generico usa i nomi campo del payload documentato', () => {
    const [command] = buildClimateCommands(device({ adapter: 'custom-json' }), {
      temp: 18,
      preset: 'off',
    });
    expect(JSON.parse(command?.payload ?? '{}')).toEqual({
      mode: 'off',
      target_temperature: 18,
    });
  });

  it('un dispositivo senza topic di comando non produce nulla', () => {
    expect(
      buildClimateCommands(device({ command_topic: null }), { temp: 20, preset: 'comfort' }),
    ).toEqual([]);
  });
});

describe('planClimateDevice', () => {
  const at = new Date(2026, 9, 21, 7, 30);
  const windows = normalizeWindows([schedule()]);

  it('comanda la fascia attiva', () => {
    const plan = planClimateDevice(device(), runtime(), windows, at);

    expect(plan.reason).toBe('schedule');
    expect(plan.target).toEqual({ temp: 20.5, preset: 'comfort' });
    expect(plan.commands).toHaveLength(1);
    expect(plan.clearOverride).toBe(false);
  });

  it('tra due fasce spegne il termostato', () => {
    const plan = planClimateDevice(device(), runtime(), windows, new Date(2026, 9, 21, 12, 0));
    expect(plan.reason).toBe('gap');
    expect(plan.target).toEqual({ temp: null, preset: 'off' });
    expect(JSON.parse(plan.commands[0]?.payload ?? '{}')).toEqual({ system_mode: 'off' });
  });

  it('senza alcuna fascia non tocca un impianto mai programmato', () => {
    const plan = planClimateDevice(device(), runtime(), [], at);
    expect(plan.reason).toBe('no-program');
    expect(plan.commands).toEqual([]);
  });

  it('un override attivo sospende il programma', () => {
    const plan = planClimateDevice(
      device(),
      runtime({
        override_target_temp: '22.0',
        override_hvac_mode: 'comfort',
        override_until: new Date(at.getTime() + 60 * 60_000),
      }),
      windows,
      at,
    );

    expect(plan.reason).toBe('override');
    expect(plan.target).toEqual({ temp: 22, preset: 'comfort' });
    expect(JSON.parse(plan.commands[0]?.payload ?? '{}')).toMatchObject({
      occupied_heating_setpoint: 22,
    });
  });

  it('un override scaduto viene azzerato e la fascia riprende nello stesso giro', () => {
    const plan = planClimateDevice(
      device(),
      runtime({
        override_target_temp: '22.0',
        override_hvac_mode: 'comfort',
        override_until: new Date(at.getTime() - 1_000),
        last_sent_target_temp: '22.0',
        last_sent_hvac_mode: 'comfort',
        last_sent_at: new Date(at.getTime() - 10_000),
      }),
      windows,
      at,
    );

    expect(plan.clearOverride).toBe(true);
    expect(plan.reason).toBe('schedule');
    expect(plan.target).toEqual({ temp: 20.5, preset: 'comfort' });
  });

  it('la vacanza spegne l’impianto e scade da sola', () => {
    const active = planClimateDevice(
      device(),
      runtime({ vacation_mode: true, vacation_until: new Date(at.getTime() + 86_400_000) }),
      windows,
      at,
    );
    expect(active.reason).toBe('vacation');
    expect(active.target).toEqual({ temp: null, preset: 'off' });

    const expired = planClimateDevice(
      device(),
      runtime({ vacation_mode: true, vacation_until: new Date(at.getTime() - 1_000) }),
      windows,
      at,
    );
    expect(expired.clearVacation).toBe(true);
    expect(expired.reason).toBe('schedule');
  });

  it('non ripete un comando identico all’ultimo trasmesso', () => {
    const plan = planClimateDevice(
      device(),
      runtime({
        last_sent_target_temp: '20.5',
        last_sent_hvac_mode: 'comfort',
        last_sent_at: new Date(at.getTime() - 60_000),
      }),
      windows,
      at,
    );

    expect(plan.reason).toBe('unchanged');
    expect(plan.commands).toEqual([]);
  });
});

describe('createClimateScheduler', () => {
  function fakeDatabase(rows: ClimateScheduleRow[], state: ClimateRuntimeRow) {
    return {
      listClimateDevices: vi.fn(async () => [device()]),
      listClimateRuntimes: vi.fn(async () => [state]),
      listClimateSchedules: vi.fn(async () => rows),
      getClimateRuntime: vi.fn(async () => state),
      clearClimateOverride: vi.fn(async () => undefined),
      clearClimateVacation: vi.fn(async () => undefined),
      recordClimateCommand: vi.fn(async () => undefined),
    };
  }

  function fakePublisher(): ClimatePublisher & { published: { topic: string; payload: string }[] } {
    const published: { topic: string; payload: string }[] = [];
    return {
      published,
      publish(topic, payload) {
        published.push({ topic, payload });
        return Promise.resolve(true);
      },
      close: async () => undefined,
    };
  }

  it('pubblica il setpoint della fascia e lo memorizza', async () => {
    const db = fakeDatabase([schedule()], runtime());
    const publisher = fakePublisher();
    const scheduler = createClimateScheduler({
      db: db as unknown as Database,
      publisher,
    });

    const result = await scheduler.tick(new Date(2026, 9, 21, 7, 30));

    expect(result.published).toBe(1);
    expect(publisher.published).toHaveLength(1);
    expect(db.recordClimateCommand).toHaveBeenCalledWith(
      'climate-living',
      20.5,
      'comfort',
      expect.any(Date),
    );
  });

  it('con il broker assente non memorizza il comando, così il giro dopo riprova', async () => {
    const db = fakeDatabase([schedule()], runtime());
    const scheduler = createClimateScheduler({
      db: db as unknown as Database,
      publisher: { publish: async () => false, close: async () => undefined },
    });

    const result = await scheduler.tick(new Date(2026, 9, 21, 7, 30));

    expect(result.errors).toBe(1);
    expect(db.recordClimateCommand).not.toHaveBeenCalled();
  });

  it('azzera un override scaduto prima di comandare il programma', async () => {
    const db = fakeDatabase(
      [schedule()],
      runtime({
        override_target_temp: '22.0',
        override_until: new Date(2026, 9, 21, 7, 0),
      }),
    );
    const scheduler = createClimateScheduler({
      db: db as unknown as Database,
      publisher: fakePublisher(),
    });

    await scheduler.tick(new Date(2026, 9, 21, 7, 30));

    expect(db.clearClimateOverride).toHaveBeenCalledWith('climate-living');
  });

  it('un errore su un dispositivo non interrompe gli altri', async () => {
    const db = fakeDatabase([], runtime());
    db.listClimateSchedules.mockRejectedValueOnce(new Error('database lento'));
    const scheduler = createClimateScheduler({
      db: db as unknown as Database,
      publisher: fakePublisher(),
    });

    const result = await scheduler.tick(new Date(2026, 9, 21, 7, 30));

    expect(result.errors).toBe(1);
    expect(result.evaluated).toBe(1);
  });

  it('se il PUBACK manca non memorizza il setpoint e lo ripete al giro successivo', async () => {
    const db = fakeDatabase([schedule()], runtime());
    const published: string[] = [];
    let confirmed = false;
    const scheduler = createClimateScheduler({
      db: db as unknown as Database,
      publisher: {
        publish(_topic, payload) {
          published.push(payload);
          return Promise.resolve(confirmed);
        },
        close: async () => undefined,
      },
    });

    const failed = await scheduler.tick(new Date(2026, 9, 21, 7, 30));

    expect(failed.errors).toBe(1);
    expect(published).toHaveLength(1);
    expect(db.recordClimateCommand).not.toHaveBeenCalled();

    // Errore rientrato: il tick successivo ritrova la discrepanza e riapplica
    // il setpoint che il broker non aveva confermato.
    confirmed = true;
    const retried = await scheduler.tick(new Date(2026, 9, 21, 7, 31));

    expect(retried.published).toBe(1);
    expect(retried.errors).toBe(0);
    expect(published).toHaveLength(2);
    expect(db.recordClimateCommand).toHaveBeenCalledTimes(1);
  });

  it('il primo giro dopo il boot ripubblica la fascia attiva ignorando la cache', async () => {
    const db = fakeDatabase(
      [schedule()],
      runtime({
        last_sent_target_temp: '20.5',
        last_sent_hvac_mode: 'comfort',
        last_sent_at: new Date(2026, 9, 21, 7, 0),
      }),
    );
    const publisher = fakePublisher();
    const scheduler = createClimateScheduler({
      db: db as unknown as Database,
      publisher,
    });

    // Un giro ordinario rispetta la cache: nessun comando al broker.
    const steady = await scheduler.tick(new Date(2026, 9, 21, 7, 30));
    expect(steady.unchanged).toBe(1);
    expect(publisher.published).toHaveLength(0);

    // Dopo un riavvio, invece, il termostato va riallineato subito.
    const boot = await scheduler.tick(new Date(2026, 9, 21, 7, 30), { force: true });

    expect(boot.published).toBe(1);
    expect(publisher.published).toHaveLength(1);
    expect(JSON.parse(publisher.published[0]?.payload ?? '{}')).toEqual({
      system_mode: 'heat',
      occupied_heating_setpoint: 20.5,
    });
    expect(db.recordClimateCommand).toHaveBeenCalledWith(
      'climate-living',
      20.5,
      'comfort',
      expect.any(Date),
    );
  });

  it('start() esegue subito il giro di recupero, senza aspettare un minuto', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 21, 7, 30) });
    try {
      const db = fakeDatabase(
        [schedule()],
        runtime({
          last_sent_target_temp: '20.5',
          last_sent_hvac_mode: 'comfort',
          last_sent_at: new Date(2026, 9, 21, 7, 0),
        }),
      );
      const publisher = fakePublisher();
      const scheduler = createClimateScheduler({
        db: db as unknown as Database,
        publisher,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(publisher.published).toHaveLength(1);
      expect(db.recordClimateCommand).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createMqttClimatePublisher', () => {
  const config = {
    mqtt: {
      url: 'mqtt://broker.local:1883',
      username: null,
      password: null,
      baseTopic: '',
    },
  } as unknown as AuthConfig;

  let acks: ((error?: Error) => void)[] = [];

  beforeEach(() => {
    acks = [];
    vi.resetAllMocks();
    mqttMock.connect.mockReturnValue(mqttMock.socket);
    mqttMock.socket.end.mockImplementation((_force: boolean, callback: () => void) => callback());
    mqttMock.socket.publish.mockImplementation(
      (_topic: string, _payload: string, _options: unknown, callback: (error?: Error) => void) => {
        acks.push(callback);
        return mqttMock.socket;
      },
    );
  });

  it('conferma il comando solo alla ricezione del PUBACK', async () => {
    const publisher = createMqttClimatePublisher(config);

    const pending = publisher.publish('casa/termostato/set', '{"system_mode":"heat"}');
    await Promise.resolve();

    expect(mqttMock.socket.publish).toHaveBeenCalledWith(
      'casa/termostato/set',
      '{"system_mode":"heat"}',
      { qos: 1 },
      expect.any(Function),
    );

    acks[0]?.();
    await expect(pending).resolves.toBe(true);
    await publisher.close();
  });

  it('un errore nel callback è un comando non consegnato', async () => {
    const publisher = createMqttClimatePublisher(config);

    const pending = publisher.publish('casa/termostato/set', '{}');
    await Promise.resolve();
    acks[0]?.(new Error('broker offline'));

    await expect(pending).resolves.toBe(false);
    await publisher.close();
  });

  it('senza PUBACK scade, così il tick non resta appeso', async () => {
    vi.useFakeTimers();
    try {
      const publisher = createMqttClimatePublisher(config);

      const pending = publisher.publish('casa/termostato/set', '{}');
      await vi.advanceTimersByTimeAsync(PUBLISH_ACK_TIMEOUT_MS);

      await expect(pending).resolves.toBe(false);
      await publisher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('senza broker configurato ogni comando è non consegnato', async () => {
    const publisher = createMqttClimatePublisher({
      mqtt: { url: null, username: null, password: null, baseTopic: '' },
    } as unknown as AuthConfig);

    await expect(publisher.publish('casa/termostato/set', '{}')).resolves.toBe(false);
    expect(mqttMock.connect).not.toHaveBeenCalled();
  });
});
