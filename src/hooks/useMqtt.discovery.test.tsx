import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHomeStore } from '@/store/homeStore';

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

beforeEach(() => {
  localStorage.clear();
  mqtt.listeners.clear();
  mqtt.subscribe.mockClear();
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
  it('sottoscrive i wildcard di discovery, scopre l’entità e ne segue i topic', () => {
    const { unmount } = renderHook(() => useMqtt([]));

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

    const device = useHomeStore.getState().devices['ha:light:pianta'];
    expect(device).toMatchObject({ kind: 'light', name: 'Pianta', room: 'salotto-nuovo' });
    expect(useHomeStore.getState().rooms.some((room) => room.id === 'salotto-nuovo')).toBe(true);

    // Sottoscrizione dinamica immediata dei canali dell'entità scoperta.
    expect(subscribedTopics()).toEqual(
      expect.arrayContaining([
        'zigbee2mqtt/pianta/state',
        'zigbee2mqtt/pianta/brightness',
      ]),
    );

    // Lo stato che arriva sull'adapter dedicato finisce nello store.
    act(() => {
      message('zigbee2mqtt/pianta/state', 'ON');
      message('zigbee2mqtt/pianta/brightness', '255');
    });

    const updated = useHomeStore.getState().devices['ha:light:pianta'];
    expect(updated?.kind === 'light' && updated.state).toMatchObject({
      on: true,
      brightness: 100,
    });

    unmount();
  });

  it('rimuove il widget quando il broker ritira l’annuncio', () => {
    const { unmount } = renderHook(() => useMqtt([]));

    act(() => {
      emit('connect');
      message(DISCOVERY_TOPIC, JSON.stringify(CONFIG));
      vi.advanceTimersByTime(300);
    });
    expect(useHomeStore.getState().devices['ha:light:pianta']).toBeDefined();

    act(() => {
      message(DISCOVERY_TOPIC, '');
      vi.advanceTimersByTime(300);
    });

    expect(useHomeStore.getState().devices['ha:light:pianta']).toBeUndefined();
    unmount();
  });

  it('marca offline l’entità dal suo availability topic', () => {
    const { unmount } = renderHook(() => useMqtt([]));

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

    expect(useHomeStore.getState().devices['ha:light:pianta']?.availability).toBe('offline');
    unmount();
  });
});
