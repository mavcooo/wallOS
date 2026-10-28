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
import type { Device } from '@/types/device';

/**
 * Socket finta: registra le chiamate di sottoscrizione e permette di forzare
 * l'errore di un singolo SUBACK/UNSUBACK.
 */
const mqtt = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const subscribe = vi.fn(
    (_topics: string[], _options: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
    },
  );
  const unsubscribe = vi.fn(
    (_topics: string[], callback?: (error?: Error) => void) => {
      callback?.();
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
    unsubscribe,
    publish: vi.fn(),
  };
  return { listeners, subscribe, unsubscribe, client, connect: vi.fn(() => client) };
});

vi.mock('mqtt', () => ({ default: { connect: mqtt.connect } }));

const { useMqtt } = await import('@/hooks/useMqtt');

const OLD_TOPIC = 'zigbee2mqtt/living/main';
const NEW_TOPIC = 'zigbee2mqtt/living/main-v2';

function emit(event: string, ...args: unknown[]) {
  const handler = mqtt.listeners.get(event);
  if (!handler) throw new Error(`handler "${event}" non registrato`);
  return handler(...args);
}

function subscribedTopics(): string[] {
  return mqtt.subscribe.mock.calls.flatMap((call) => call[0] as string[]);
}

function unsubscribedTopics(): string[] {
  return mqtt.unsubscribe.mock.calls.flatMap((call) => call[0] as string[]);
}

function topologyOf(client: ReturnType<typeof createTestQueryClient>): Topology | undefined {
  return client.getQueryData<Topology>(TOPOLOGY_QUERY_KEY);
}

/** Cambia il topic di stato di un device, come farebbe Admin → Dispositivi. */
function withStateTopic(topology: Topology, deviceId: string, stateTopic: string): Topology {
  return {
    ...topology,
    devices: topology.devices.map((device) =>
      device.id === deviceId
        ? ({ ...device, topics: { ...device.topics, state: stateTopic } } as Device)
        : device,
    ),
  };
}

/** Stessa composizione della produzione: topologia in TanStack Query → hook. */
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
  mqtt.subscribe.mockImplementation(
    (_topics: string[], _options: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
    },
  );
  mqtt.unsubscribe.mockClear();
  mqtt.unsubscribe.mockImplementation(
    (_topics: string[], callback?: (error?: Error) => void) => {
      callback?.();
    },
  );
  mqtt.client.end.mockClear();
  mqtt.client.removeAllListeners.mockClear();
  mqtt.client.connected = true;
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

describe('useMqtt · riconciliazione sottoscrizioni', () => {
  it('annulla il vecchio stateTopic e sottoscrive solo il nuovo', async () => {
    const { client, unmount } = setup();

    act(() => {
      emit('connect');
    });
    expect(subscribedTopics()).toContain(OLD_TOPIC);

    mqtt.subscribe.mockClear();
    mqtt.unsubscribe.mockClear();

    await act(async () => {
      const topology = topologyOf(client);
      if (!topology) throw new Error('topologia non seminata');
      client.setQueryData(
        TOPOLOGY_QUERY_KEY,
        withStateTopic(topology, 'light-living-main', NEW_TOPIC),
      );
      await vi.advanceTimersByTimeAsync(1);
    });

    // Il broker riceve UNSUBSCRIBE per il topic obsoleto...
    expect(mqtt.unsubscribe).toHaveBeenCalledWith([OLD_TOPIC], expect.any(Function));
    // ...e SUBSCRIBE solo per quello nuovo (l'availability non è cambiata).
    expect(subscribedTopics()).toEqual([NEW_TOPIC]);

    // Un payload residuo sul vecchio topic non tocca lo store: non è più
    // nell'indice, quindi non arriva né all'adapter né al buffer telemetria.
    const before = useHomeStore.getState().deviceStates['light-living-main'];
    act(() => {
      emit('message', OLD_TOPIC, Buffer.from('ON'), { qos: 0, retain: false });
    });
    expect(useHomeStore.getState().deviceStates['light-living-main']).toBe(before);

    unmount();
  });

  it('non lascia attivo un topic rifiutato dal SUBACK e lo riprova', () => {
    mqtt.subscribe.mockImplementationOnce(
      (_topics: string[], _options: unknown, callback?: (error: Error | null) => void) => {
        callback?.(new Error('SUBACK rifiutato'));
      },
    );

    const { result, unmount } = setup();
    act(() => {
      emit('connect');
    });

    // Il primo tentativo è fallito: il topic non deve restare marcato come attivo.
    mqtt.subscribe.mockClear();
    act(() => {
      result.current.refreshSubscriptions();
    });

    expect(subscribedTopics()).toContain(OLD_TOPIC);

    unmount();
  });

  it('se l’UNSUBSCRIBE fallisce il topic resta tracciato per il retry', async () => {
    const { client, result, unmount } = setup();
    act(() => {
      emit('connect');
    });

    mqtt.unsubscribe.mockClear();
    mqtt.unsubscribe.mockImplementationOnce(
      (_topics: string[], callback?: (error?: Error) => void) => {
        callback?.(new Error('UNSUBACK assente'));
      },
    );

    await act(async () => {
      const topology = topologyOf(client);
      if (!topology) throw new Error('topologia non seminata');
      client.setQueryData(TOPOLOGY_QUERY_KEY, {
        ...topology,
        devices: topology.devices.filter((device) => device.id !== 'light-living-main'),
      });
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(mqtt.unsubscribe).toHaveBeenCalledTimes(1);

    // Il topic è tornato tra i "sottoscritti": il reconcile successivo riprova.
    act(() => {
      result.current.refreshSubscriptions();
    });

    expect(mqtt.unsubscribe).toHaveBeenCalledTimes(2);
    expect(mqtt.unsubscribe).toHaveBeenLastCalledWith(
      expect.arrayContaining([OLD_TOPIC]),
      expect.any(Function),
    );

    unmount();
  });

  it('allo smontaggio annulla tutti i topic tracciati e chiude senza forzare', () => {
    const { unmount } = setup();
    act(() => {
      emit('connect');
    });

    mqtt.unsubscribe.mockClear();
    mqtt.client.end.mockClear();

    unmount();

    const removed = unsubscribedTopics();
    expect(removed).toEqual(
      expect.arrayContaining([OLD_TOPIC, `${OLD_TOPIC}/availability`]),
    );
    // `end()` senza `true`: la coda con gli UNSUBSCRIBE deve poter uscire.
    expect(mqtt.client.end).toHaveBeenCalledWith();
    expect(mqtt.client.end).not.toHaveBeenCalledWith(true);
  });
});
