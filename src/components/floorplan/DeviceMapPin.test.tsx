import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendAction: vi.fn() }));

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({ sendAction: mocks.sendAction }),
}));

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

const { DeviceMapPin, LONG_PRESS_MS } = await import('./DeviceMapPin');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');

beforeEach(() => {
  localStorage.clear();
  mocks.sendAction.mockClear();
  useHomeStore.setState({ deviceStates: {} });
});

function pin() {
  return screen.getByRole('button', { name: /Luce principale/ });
}

describe('DeviceMapPin · gesture touch', () => {
  it('un tap singolo comanda subito il dispositivo', () => {
    renderWithTopology(
      <DeviceMapPin
        deviceId="light-living-main"
        pin={{ x: 40, y: 30 }}
        name="Luce principale"
        kind="light"
        onOpenDetail={vi.fn()}
      />,
      { topology: SEED_TOPOLOGY },
    );

    const button = pin();
    // Nel seed la luce è accesa: il tap manda lo spegnimento.
    fireEvent.pointerDown(button, { clientX: 10, clientY: 10, pointerType: 'touch' });
    fireEvent.pointerUp(button, { clientX: 10, clientY: 10, pointerType: 'touch' });

    expect(mocks.sendAction).toHaveBeenCalledTimes(1);
    expect(mocks.sendAction).toHaveBeenCalledWith('light-living-main', {
      type: 'power',
      on: false,
    });
  });

  it('la pressione prolungata apre il dettaglio e non comanda', () => {
    vi.useFakeTimers();
    const onOpenDetail = vi.fn();

    try {
      renderWithTopology(
        <DeviceMapPin
          deviceId="light-living-main"
          pin={{ x: 40, y: 30 }}
          name="Luce principale"
          kind="light"
          onOpenDetail={onOpenDetail}
        />,
        { topology: SEED_TOPOLOGY },
      );

      const button = pin();
      fireEvent.pointerDown(button, { pointerType: 'touch' });

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(onOpenDetail).toHaveBeenCalledWith('light-living-main');

      fireEvent.pointerUp(button, { pointerType: 'touch' });
      expect(mocks.sendAction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('non propaga il tocco al contenitore della stanza', () => {
    const parent = vi.fn();

    renderWithTopology(
      <div onPointerDown={parent} onPointerUp={parent}>
        <DeviceMapPin
          deviceId="light-living-main"
          pin={{ x: 40, y: 30 }}
          name="Luce principale"
          kind="light"
          onOpenDetail={vi.fn()}
        />
      </div>,
      { topology: SEED_TOPOLOGY },
    );

    const button = pin();
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    fireEvent.pointerUp(button, { pointerType: 'touch' });

    expect(parent).not.toHaveBeenCalled();
  });

  it('posiziona il marker con coordinate percentuali dentro la stanza', () => {
    renderWithTopology(
      <DeviceMapPin
        deviceId="light-living-main"
        pin={{ x: 40, y: 30 }}
        name="Luce principale"
        kind="light"
        onOpenDetail={vi.fn()}
      />,
      { topology: SEED_TOPOLOGY },
    );

    const button = pin();
    expect(button.style.left).toBe('40%');
    expect(button.style.top).toBe('30%');
    expect(button).toHaveAttribute('data-state', 'on');
  });
});
