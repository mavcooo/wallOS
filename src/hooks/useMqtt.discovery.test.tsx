import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { useDevices } from '@/hooks/useTopologyQuery';
import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import type { Topology } from '@/lib/topologyApi';
import { useOfflineQueue } from '@/mqtt/offlineQueue';
import {
  onTopologyChanged,
  type TopologyChangedEvent,
} from '@/mqtt/topologyEvents';
import { useHomeStore } from '@/store/homeStore';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import { createTestQueryClient, seedTopology } from '@/test/query';

/** Client MQTT finto: registra gli handler e le sottoscrizioni del hook. */
const mqtt = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const subscribe = vi.fn(
    (_topics: string[], _options: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
    },
  );
  const client = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
      return client;
    }),
    removeAllListeners: vi.fn(),
    end: vi.fn(),
    subscribe,
    unsubscribe: vi.fn(),
    publish: vi.fn(),
  };
  const connect = vi.fn(() => client);
  return { listeners, subscribe, client, connect };
});

vi.mock('mqtt', () => ({ default: { connect: mqtt.connect } }));

const { useMqtt } = await import('@/hooks/useMqtt');

const DISCOVERY_TOPIC = 'homeassistant/light/pianta/config';
const CONFIG = {
  name: 'Pianta',
  stat_t: 'zigbee2mqtt/pianta/state',
  cmd_t: 'zigbee2mqtt/pianta/set',
  bri_stat_t: 'zigbee2mqtt/pianta/brightness',
  dev: { name: 'Pianta', suggested_area: 'Salotto nuovo' },
};

function emit(event: string, ...args: unknown[]) {
  const handler = mqtt.listeners.get(event);
  if (!handler) throw new Error(`handler "${event}" non registrato`);
  return handler(...args);
}

function message(topic: string, payload: string) {
  emit('message', topic, Buffer.from(payload), { qos: 0, retain: true });
}

function subscribedTopics(): string[] {
  return mqtt.subscribe.mock.calls.flatMap((call) => call[0] as string[]);
}

function topologyOf(client: ReturnType<typeof createTestQueryClient>): Topology | undefined {
  return client.getQueryData<Topology>(TOPOLOGY_QUERY_KEY);
}

/** La topologia è in Query: il provider la fornisce al hook come in produzione. */
function setup() {
  const client = createTestQueryClient();
  seedTopology(client, SEED_TOPOLOGY);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useMqtt([], useDevices()), { wrapper });
  return { ...hook, client };
}

beforeEach(() => {
  localStorage.clear();
  mqtt.listeners.clear();
  mqtt.subscribe.mockClear();
  mqtt.client.unsubscribe.mockClear();
  useHomeStore.setState({ deviceStates: {} });
  useHomeStore.getState().updateBroker({
    demoMode: false,
    host: 'broker.test',
    clientId: 'kiosk-test',
    baseTopic: '',
    username: '',
    password: '',
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMqtt · Home Assistant Discovery', () => {
  it('sottoscrive i wildcard, scopre l’entità e ne segue i topic', () => {
    const { unmount, client } = setup();

    act(() => {
      emit('connect');
    });

    expect(subscribedTopics()).toEqual(
      expect.arrayContaining(['homeassistant/+/+/config', 'homeassistant/+/+/+/config']),
    );

    act(() => {
      message(DISCOVERY_TOPIC, JSON.stringify(CONFIG));
      vi.advanceTimersByTime(300);
    });

    const discovered = topologyOf(client)?.devices.find(
      (device) => device.id === 'ha:light:pianta',
    );
    expect(discovered).toMatchObject({
      kind: 'light',
      name: 'Pianta',
      room: 'salotto-nuovo',
    });
    // La stanza scoperta estende la topologia in cache, non lo store.
    expect(
      topologyOf(client)?.rooms.some((room) => room.id === 'salotto-nuovo'),
    ).toBe(true);
    expect(useHomeStore.getState()).not.toHaveProperty('rooms');

    // Sottoscrizione dinamica immediata dei canali dell'entità scoperta.
    expect(subscribedTopics()).toEqual(
      expect.arrayContaining([
        'zigbee2mqtt/pianta/state',
        'zigbee2mqtt/pianta/brightness',
      ]),
    );

    // Lo stato che arriva sull'adapter dedicato finisce nella riga realtime.
    act(() => {
      message('zigbee2mqtt/pianta/state', 'ON');
      message('zigbee2mqtt/pianta/brightness', '255');
    });

    const updated = useHomeStore.getState().deviceStates['ha:light:pianta'];
    expect(updated?.kind === 'light' && updated.state).toMatchObject({
      on: true,
      brightness: 100,
    });

    unmount();
  });

  it('rimuove i metadati quando il broker ritira l’annuncio', () => {
    const { unmount, client } = setup();

    act(() => {
      emit('connect');
      message(DISCOVERY_TOPIC, JSON.stringify(CONFIG));
      vi.advanceTimersByTime(300);
    });
    expect(
      topologyOf(client)?.devices.some((device) => device.id === 'ha:light:pianta'),
    ).toBe(true);

    act(() => {
      message(DISCOVERY_TOPIC, '');
      vi.advanceTimersByTime(300);
    });

    expect(
      topologyOf(client)?.devices.some((device) => device.id === 'ha:light:pianta'),
    ).toBe(false);
    unmount();
  });

  it('annulla i topic di un device rimosso dalla topologia', async () => {
    const { client, unmount } = setup();

    act(() => {
      emit('connect');
    });
    expect(subscribedTopics()).toContain('zigbee2mqtt/living/main');

    mqtt.client.unsubscribe.mockClear();
    await act(async () => {
      const topology = topologyOf(client);
      if (!topology) throw new Error('topologia non seminata');
      client.setQueryData(TOPOLOGY_QUERY_KEY, {
        ...topology,
        devices: topology.devices.filter((device) => device.id !== 'light-living-main'),
      });
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(mqtt.client.unsubscribe).toHaveBeenCalledWith(
      expect.arrayContaining([
        'zigbee2mqtt/living/main',
        'zigbee2mqtt/living/main/availability',
      ]),
    );
    unmount();
  });

  it('sottoscrive i filtri sniffer e li annulla alla chiusura', () => {
    const { result, unmount } = setup();

    act(() => {
      emit('connect');
    });

    let stop: (() => void) | null = null;
    act(() => {
      stop = result.current.subscribeSniffer(['tele/#', 'shellies/#']);
    });

    expect(subscribedTopics()).toEqual(expect.arrayContaining(['tele/#', 'shellies/#']));

    act(() => {
      stop?.();
    });

    expect(mqtt.client.unsubscribe).toHaveBeenCalledWith(['tele/#', 'shellies/#']);
    unmount();
  });

  it('applica il base topic ai filtri sniffer', () => {
    useHomeStore.getState().updateBroker({ baseTopic: 'casa' });
    const { result, unmount } = setup();

    act(() => {
      emit('connect');
    });

    let stop: (() => void) | null = null;
    act(() => {
      stop = result.current.subscribeSniffer(['tele/#']);
    });

    expect(subscribedTopics()).toContain('casa/tele/#');
    expect(subscribedTopics()).not.toContain('tele/#');

    act(() => {
      stop?.();
    });
    expect(mqtt.client.unsubscribe).toHaveBeenCalledWith(['casa/tele/#']);
    unmount();
  });

  it('marca offline l’entità dal suo availability topic', () => {
    const { unmount } = setup();

    act(() => {
      emit('connect');
      message(
        DISCOVERY_TOPIC,
        JSON.stringify({
          ...CONFIG,
          avty_t: 'zigbee2mqtt/pianta/availability',
          pl_avail: 'online',
          pl_not_avail: 'offline',
        }),
      );
      vi.advanceTimersByTime(300);
    });

    act(() => {
      message('zigbee2mqtt/pianta/availability', 'offline');
    });

    const row = useHomeStore.getState().deviceStates['ha:light:pianta'];
    expect(row?.availability).toBe('offline');
    expect(row?.isAvailable).toBe(false);
    unmount();
  });
});

describe('useMqtt · disponibilità LWT dei device statici', () => {
  it('applica il JSON Zigbee2MQTT senza sovrascrivere le metriche', () => {
    const { unmount } = setup();

    act(() => {
      emit('connect');
      message('zigbee2mqtt/living/main', 'ON');
      message('zigbee2mqtt/living/main/availability', '{"state":"offline"}');
      vi.advanceTimersByTime(300);
    });

    const offline = useHomeStore.getState().deviceStates['light-living-main'];
    expect(offline?.availability).toBe('offline');
    expect(offline?.isAvailable).toBe(false);
    // L'ultima lettura resta visibile: la card mostra il dato, non lo perde.
    expect(offline?.kind === 'light' && offline.state.on).toBe(true);

    act(() => {
      message('zigbee2mqtt/living/main/availability', '{"state":"online"}');
    });

    const online = useHomeStore.getState().deviceStates['light-living-main'];
    expect(online?.availability).toBe('online');
    expect(online?.isAvailable).toBe(true);
    unmount();
  });

  it('accetta i payload Tasmota e ignora i retained sconosciuti', () => {
    const { unmount } = setup();

    act(() => {
      emit('connect');
      // Payload non riconosciuto: nessun cambio di stato (resta lo snapshot).
      message('zigbee2mqtt/living/main/availability', '');
    });
    expect(
      useHomeStore.getState().deviceStates['light-living-main']?.isAvailable,
    ).toBe(true);

    act(() => {
      message('zigbee2mqtt/living/main/availability', 'Offline');
    });
    expect(useHomeStore.getState().deviceStates['light-living-main']?.availability).toBe(
      'offline',
    );

    act(() => {
      message('zigbee2mqtt/living/main/availability', 'Online');
    });
    expect(useHomeStore.getState().deviceStates['light-living-main']?.availability).toBe(
      'online',
    );
    unmount();
  });
});

describe('useMqtt · heartbeat e watchdog anti-freeze', () => {
  it('sottoscrive i topic heartbeat e pubblica il primo ping al connect', () => {
    const { unmount } = setup();

    act(() => {
      emit('connect');
    });

    expect(subscribedTopics()).toEqual(
      expect.arrayContaining(['wallos/heartbeat/ping', 'wallos/heartbeat/pong']),
    );
    // Il primo ping parte subito: senza traffico entrante il clock del
    // watchdog non partirebbe mai.
    expect(mqtt.client.publish).toHaveBeenCalledWith(
      'wallos/heartbeat/ping',
      expect.stringContaining('"timestamp"'),
      { qos: 0, retain: false },
    );
    unmount();
  });

  it('un pong azzera il clock e aggiorna la latenza', () => {
    const { unmount } = setup();

    act(() => {
      emit('connect');
      vi.advanceTimersByTime(2_000);
      message(
        'wallos/heartbeat/ping',
        JSON.stringify({ clientId: 'kiosk-test', timestamp: Date.now() - 42 }),
      );
    });

    const connection = useHomeStore.getState().connection;
    expect(connection.lastNetworkActivityAt).not.toBeNull();
    expect(connection.latencyMs).not.toBeNull();
    expect(connection.latencyMs).toBeGreaterThanOrEqual(0);
    unmount();
  });

  it('senza traffico per oltre 90 s dichiara il freeze e riapre la socket', () => {
    const { unmount } = setup();

    act(() => {
      emit('connect');
    });
    expect(useHomeStore.getState().connection.status).toBe('connected');

    // Il socket resta "connesso" agli occhi di mqtt.js: nessun close event.
    mqtt.client.connected = true;
    act(() => {
      // 120 s di silenzio: supera la soglia dei 90 s.
      vi.advanceTimersByTime(120_000);
    });

    const connection = useHomeStore.getState().connection;
    expect(connection.status).toBe('stale');
    expect(connection.frozenSince).not.toBeNull();
    expect(connection.lastError).toMatch(/Nessun pacchetto/);
    // La socket zombie è stata chiusa forzatamente e una nuova istanza aperta.
    expect(mqtt.client.end).toHaveBeenCalledWith(true);
    expect(mqtt.connect).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('un ritorno di traffico riporta lo stato a connesso', () => {
    const { unmount } = setup();

    act(() => {
      emit('connect');
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(useHomeStore.getState().connection.status).toBe('stale');

    // Il broker risponde di nuovo: CONNACK + pong.
    act(() => {
      emit('connect');
      message(
        'wallos/heartbeat/pong',
        JSON.stringify({ clientId: 'kiosk-test', timestamp: Date.now() }),
      );
    });

    const connection = useHomeStore.getState().connection;
    expect(connection.status).toBe('connected');
    expect(connection.frozenSince).toBeNull();
    unmount();
  });

  it('i topic heartbeat non vengono rimossi dalla riconciliazione sniffer', () => {
    const { result, unmount } = setup();

    act(() => {
      emit('connect');
    });

    let stop: (() => void) | null = null;
    act(() => {
      stop = result.current.subscribeSniffer(['tele/#']);
    });
    act(() => {
      stop?.();
    });

    // La riconciliazione non deve mai staccare il proprio heartbeat.
    expect(mqtt.client.unsubscribe).not.toHaveBeenCalledWith(
      expect.arrayContaining(['wallos/heartbeat/ping']),
    );
    unmount();
  });
});

describe('useMqtt · Safe Boot', () => {
  it('conta i retained e li applica subito allo store', () => {
    const { unmount } = setup();

    act(() => {
      useHomeStore.setState({ deviceStates: {} });
      useHomeStore.getState().syncDeviceStates(SEED_TOPOLOGY.devices);
      emit('connect');
    });

    const before = useHomeStore.getState().recovery.retainedMessagesReceived;
    act(() => {
      // 254 = fondo scala Zigbee2MQTT → 100% per l'adapter.
      message('zigbee2mqtt/living/main', '{"state":"ON","brightness":254}');
    });

    expect(useHomeStore.getState().recovery.retainedMessagesReceived).toBe(before + 1);
    const retainedRow = useHomeStore.getState().deviceStates['light-living-main'];
    // Nessun passaggio dal buffer di telemetria: il valore retained è già lì.
    expect(retainedRow?.kind === 'light' && retainedRow.state.brightness).toBe(100);

    // Telemetria live: non è un retained, non entra nel conteggio di idratazione.
    act(() => {
      emit('message', 'zigbee2mqtt/living/main', Buffer.from('{"state":"OFF"}'), {
        qos: 0,
        retain: false,
      });
    });
    expect(useHomeStore.getState().recovery.retainedMessagesReceived).toBe(before + 1);
    unmount();
  });

  it('blocca i comandi durante l’idratazione e li riabilita a fine sync', () => {
    const { result, unmount } = setup();

    act(() => {
      useHomeStore.setState({ deviceStates: {} });
      useHomeStore.getState().syncDeviceStates(SEED_TOPOLOGY.devices);
      useOfflineQueue.setState({ commands: [] });
      emit('connect');
    });

    expect(useHomeStore.getState().recovery.isHydrating).toBe(true);
    act(() => {
      result.current.sendAction('light-living-main', { type: 'power', on: true });
    });
    // Nessun comando accodato: l'utente non ha ancora visto lo stato reale.
    expect(useOfflineQueue.getState().commands).toHaveLength(0);

    act(() => {
      useHomeStore.getState().finishHydration();
      result.current.sendAction('light-living-main', { type: 'power', on: true });
    });
    expect(useOfflineQueue.getState().commands).toHaveLength(1);

    // Isolamento: i test successivi del file ripartono in idratazione.
    act(() => {
      useHomeStore.setState({
        recovery: { ...useHomeStore.getState().recovery, isHydrating: true },
      });
      useOfflineQueue.setState({ commands: [] });
    });
    unmount();
  });
});

describe('useMqtt · eventi di topologia', () => {
  it('sottoscrive il topic di sistema e instrada l’evento alla sync', () => {
    const received: TopologyChangedEvent[] = [];
    const stopListening = onTopologyChanged((event) => received.push(event));
    const { unmount } = setup();

    act(() => {
      emit('connect');
    });
    expect(subscribedTopics()).toContain('wallos/system/topology_changed');

    act(() => {
      message(
        'wallos/system/topology_changed',
        JSON.stringify({
          event: 'device_created',
          entity: 'device',
          id: 'lampada-studio',
          timestamp: 1_730_000_000_000,
          sourceClientId: 'admin-pc',
        }),
      );
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event: 'device_created',
      entity: 'device',
      id: 'lampada-studio',
      sourceClientId: 'admin-pc',
    });

    // Payload malformato: nessun evento arriva alla sincronizzazione.
    act(() => {
      message('wallos/system/topology_changed', 'non-json');
    });
    expect(received).toHaveLength(1);

    stopListening();
    unmount();
  });
});
