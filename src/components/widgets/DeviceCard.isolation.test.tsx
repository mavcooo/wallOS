import { act } from '@testing-library/react';
import { Profiler } from 'react';
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

const { DeviceCard } = await import('@/components/widgets/DeviceCard');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
});

describe('DeviceCard · isolamento dei re-render', () => {
  it('un aggiornamento MQTT su un device non ridisegna la card vicina', () => {
    const renderedA = vi.fn();
    const renderedB = vi.fn();
    const onA = vi.fn();
    const onB = vi.fn();

    const Probe = () => {
      renderedA();
      return <DeviceCard deviceId="light-living-main" />;
    };
    const ProbeB = () => {
      renderedB();
      return <DeviceCard deviceId="light-living-ambient" />;
    };

    renderWithTopology(
      <div>
        <Profiler id="a" onRender={onA}>
          <Probe />
        </Profiler>
        <Profiler id="b" onRender={onB}>
          <ProbeB />
        </Profiler>
      </div>,
      { topology: SEED_TOPOLOGY },
    );

    expect(renderedA).toHaveBeenCalled();
    expect(renderedB).toHaveBeenCalled();
    renderedA.mockClear();
    renderedB.mockClear();
    onA.mockClear();
    onB.mockClear();

    // Un solo payload, una sola riga toccata: `applyDecoded` è O(1).
    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('light-living-main', { kind: 'light', state: { brightness: 41 } });
    });

    // Il wrapper non ridisegna: la sottoscrizione vive dentro DeviceCard.
    expect(renderedA).not.toHaveBeenCalled();
    expect(renderedB).not.toHaveBeenCalled();
    // Solo il subtree della card aggiornata committa.
    expect(onA).toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
  });
});
