import { Profiler } from 'react';
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({
    sendAction: vi.fn(),
    publishRaw: vi.fn(),
    runScenario: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

/**
 * Una presa ha due observer: la card live (`LivePowerCard`) e la riga
 * dell'elenco (`SocketRow`). Entrambi leggono i metadati con
 * `useDeviceMetadata`, che quindi conta i render reali per device — a
 * differenza di un wrapper, che conterebbe quelli del parent.
 */
const widgetReads: string[] = [];

vi.mock('@/hooks/useTopologyQuery', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTopologyQuery')>(
    '@/hooks/useTopologyQuery',
  );
  return {
    ...actual,
    useDeviceMetadata: (deviceId: string) => {
      widgetReads.push(deviceId);
      return actual.useDeviceMetadata(deviceId);
    },
  };
});

const { EnergyPage } = await import('@/pages/EnergyPage');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
  widgetReads.length = 0;
});

describe('EnergyPage · isolamento dei re-render', () => {
  it('la telemetria di un device senza contatore non ridisegna la pagina', () => {
    const pageRenders = vi.fn();
    renderWithTopology(
      <Profiler id="energy" onRender={pageRenders}>
        <EnergyPage />
      </Profiler>,
      { topology: SEED_TOPOLOGY },
    );
    widgetReads.length = 0;
    pageRenders.mockClear();

    // Sensore fumo: non ha un meter, nessun subtree della pagina lo osserva.
    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('sensor-kitchen-smoke', { kind: 'sensor', state: { value: false } });
    });

    expect(pageRenders).not.toHaveBeenCalled();
    expect(widgetReads).toEqual([]);
  });

  it('un payload su una presa ridisegna solo i suoi due observer', () => {
    renderWithTopology(<EnergyPage />, { topology: SEED_TOPOLOGY });
    widgetReads.length = 0;

    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('power-study-desk', { kind: 'power', state: { on: true, watts: 940 } });
    });

    // Card live + riga dell'elenco, nessun altro device.
    expect(new Set(widgetReads)).toEqual(new Set(['power-study-desk']));
    expect(widgetReads).toHaveLength(2);
    // Il nuovo valore arriva davvero a schermo (card e riga).
    expect(screen.getAllByText('940 W').length).toBeGreaterThan(0);
  });

  it('una presa che oscilla non ridisegna le card delle altre prese', () => {
    renderWithTopology(<EnergyPage />, { topology: SEED_TOPOLOGY });
    widgetReads.length = 0;

    for (let tick = 0; tick < 5; tick += 1) {
      act(() => {
        useHomeStore
          .getState()
          .applyDecoded('power-kitchen-oven', {
            kind: 'power',
            state: { on: true, watts: 1_200 + tick },
          });
      });
    }

    // 5 tick × (card + riga) = 10 render, tutti del forno.
    expect(widgetReads).toHaveLength(10);
    expect(new Set(widgetReads)).toEqual(new Set(['power-kitchen-oven']));
  });
});
