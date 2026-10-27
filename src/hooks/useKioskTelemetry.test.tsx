import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { useHomeStore } from '@/store/homeStore';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import { createTestQueryClient, seedTopology } from '@/test/query';
import { installFakeBattery, removeFakeBattery } from '@/test/battery';
import type { BatteryTelemetryPayload } from '@/services/kioskTelemetry';
import { setKioskId } from '@/utils/kioskIdentity';

/** Client MQTT finto: registra publish, sottoscrizioni ed eventi del hook. */
const mqtt = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const client = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
      return client;
    }),
    removeAllListeners: vi.fn(),
    end: vi.fn(),
    subscribe: vi.fn(
      (_topics: string[], _options: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null);
      },
    ),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
  };
  const connect = vi.fn(() => client);
  return { listeners, client, connect };
});

vi.mock('mqtt', () => ({ default: { connect: mqtt.connect } }));

const { MqttProvider } = await import('@/mqtt/MqttProvider');
const { useKioskTelemetry } = await import('@/hooks/useKioskTelemetry');

const KIOSK_ID = 'tablet_ingresso';
const BASE_TOPIC = 'casa';
const EXPECTED_TOPIC = `${BASE_TOPIC}/wallos/kiosk/${KIOSK_ID}/battery`;

function emit(event: string, ...args: unknown[]): void {
  const handler = mqtt.listeners.get(event);
  if (!handler) throw new Error(`handler "${event}" non registrato`);
  handler(...args);
}

function TelemetryProbe() {
  useKioskTelemetry({ publishIntervalMs: 60_000 });
  return null;
}

function renderTelemetry() {
  const client = createTestQueryClient();
  seedTopology(client, SEED_TOPOLOGY);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <MqttProvider>
      <TelemetryProbe />
    </MqttProvider>,
    { wrapper },
  );
}

/** Tutti i publish verso il topic batteria (l'heartbeat ne produce altri). */
function batteryMessages() {
  return mqtt.client.publish.mock.calls.filter(([topic]) => String(topic).endsWith('/battery'));
}

function lastBattery(): {
  topic: string;
  payload: BatteryTelemetryPayload;
  options: unknown;
} | null {
  const call = batteryMessages().at(-1);
  if (!call) return null;
  return {
    topic: String(call[0]),
    payload: JSON.parse(String(call[1])) as BatteryTelemetryPayload,
    options: call[2],
  };
}

beforeEach(() => {
  localStorage.clear();
  mqtt.listeners.clear();
  mqtt.client.publish.mockClear();
  mqtt.client.subscribe.mockClear();
  useHomeStore.setState({ deviceStates: {} });
  useHomeStore.getState().updateBroker({
    demoMode: false,
    host: 'broker.test',
    clientId: 'kiosk-test',
    baseTopic: BASE_TOPIC,
    username: '',
    password: '',
  });
  // Rinomina del display: è l'id che finisce nel topic e nel payload.
  setKioskId(KIOSK_ID);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeBattery();
});

describe('useKioskTelemetry · pubblicazione su MQTT', () => {
  it('pubblica livello e stato di carica con QoS 1 e retain', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.62;
    battery.charging = false;

    renderTelemetry();
    await act(async () => {});
    act(() => {
      emit('connect');
    });
    await act(async () => {});

    const message = lastBattery();
    expect(message?.topic).toBe(EXPECTED_TOPIC);
    expect(message?.payload).toMatchObject({
      kioskId: KIOSK_ID,
      level: 62,
      charging: false,
    });
    expect(typeof message?.payload.timestamp).toBe('number');
    expect(message?.options).toEqual({ qos: 1, retain: true });
  });

  it('all’80% in carica lo comunica subito (la presa stacca)', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.78;
    battery.charging = true;

    renderTelemetry();
    await act(async () => {});
    act(() => {
      emit('connect');
    });
    await act(async () => {});

    act(() => {
      battery.level = 0.8;
      battery.dispatchEvent(new Event('levelchange'));
    });

    expect(lastBattery()?.payload).toMatchObject({ level: 80, charging: true });
  });

  it('al 20% comunica che la carica è ripartita', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.22;
    battery.charging = false;

    renderTelemetry();
    await act(async () => {});
    act(() => {
      emit('connect');
    });
    await act(async () => {});

    act(() => {
      battery.level = 0.2;
      battery.dispatchEvent(new Event('levelchange'));
    });

    expect(lastBattery()?.payload).toMatchObject({ level: 20, charging: false });
  });

  it('la presa che stacca la carica aggiorna il payload anche a livello invariato', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.8;
    battery.charging = true;

    renderTelemetry();
    await act(async () => {});
    act(() => {
      emit('connect');
    });
    await act(async () => {});
    expect(lastBattery()?.payload.charging).toBe(true);

    // L'alimentatore è stato staccato: il livello non cambia, lo stato sì.
    act(() => {
      battery.charging = false;
      battery.dispatchEvent(new Event('chargingchange'));
    });

    expect(lastBattery()?.payload).toMatchObject({ level: 80, charging: false });
  });

  it('rifresca il retained ogni minuto anche senza cambi di stato', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.5;

    renderTelemetry();
    await act(async () => {});
    act(() => {
      emit('connect');
    });
    await act(async () => {});
    const before = batteryMessages().length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(batteryMessages()).toHaveLength(before + 1);
    expect(lastBattery()?.payload.level).toBe(50);
  });

  it('non pubblica nulla dove la Battery API non esiste', async () => {
    removeFakeBattery();

    renderTelemetry();
    await act(async () => {});
    act(() => {
      emit('connect');
    });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(batteryMessages()).toHaveLength(0);
  });

  it('smette di pubblicare allo smontaggio', async () => {
    const { battery } = installFakeBattery();
    battery.level = 0.45;

    const view = renderTelemetry();
    await act(async () => {});
    act(() => {
      emit('connect');
    });
    await act(async () => {});
    const before = batteryMessages().length;

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });

    expect(batteryMessages()).toHaveLength(before);
  });
});
