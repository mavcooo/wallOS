import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { useDevices } from '@/hooks/useTopologyQuery';
import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import type { Topology } from '@/lib/topologyApi';
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

    expect(useHomeStore.getState().deviceStates['ha:light:pianta']?.availability).toBe(
      'offline',
    );
    unmount();
  });
});
