import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({ sendAction: vi.fn() }),
}));

const { RoomsPage } = await import('@/pages/RoomsPage');
const { useAuthStore } = await import('@/store/authStore');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');

function gesture(target: Element, fromX: number, toX: number): void {
  fireEvent.touchStart(target, {
    touches: [{ clientX: fromX, clientY: 120, identifier: 1 }],
  });
  fireEvent.touchMove(target, {
    touches: [{ clientX: toX, clientY: 120, identifier: 1 }],
  });
  fireEvent.touchEnd(target, { touches: [] });
}

beforeEach(() => {
  localStorage.clear();
  useHomeStore.getState().setRoom('living');
  useAuthStore.setState({
    status: 'authenticated',
    elevated: false,
    user: {
      id: 'u-admin',
      username: 'admin',
      name: 'Amministratore',
      initials: 'AM',
      role: 'admin',
      allowedRooms: null,
      active: true,
      isKioskDevice: false,
      kioskDeviceId: null,
      lastAccess: null,
      pinLength: 4,
    },
  });
});

describe('RoomsPage · swipe tra stanze', () => {
  it('lo swipe a sinistra passa alla stanza successiva e aggiorna lo store', () => {
    renderWithTopology(<RoomsPage />, { topology: SEED_TOPOLOGY });
    const rooms = SEED_TOPOLOGY.rooms;
    const surface = screen.getByTestId('rooms-swipe-surface');

    gesture(surface, 240, 100);

    expect(useHomeStore.getState().ui.room).toBe(rooms[1]?.id);
  });

  it('alla prima stanza fa bounce senza cambiare pagina né stanza', () => {
    renderWithTopology(<RoomsPage />, { topology: SEED_TOPOLOGY });
    const first = SEED_TOPOLOGY.rooms[0];
    expect(first).toBeDefined();
    const surface = screen.getByTestId('rooms-swipe-surface');

    gesture(surface, 100, 240);

    expect(useHomeStore.getState().ui.room).toBe(first?.id);
    expect(surface.className).toContain('translate-x-1');
  });

  it('uno swipe che parte da uno slider non cambia stanza', () => {
    const { container } = renderWithTopology(<RoomsPage />, { topology: SEED_TOPOLOGY });
    const surface = screen.getByTestId('rooms-swipe-surface');
    const ignored = container.querySelector('.ignore-swipe');
    expect(ignored).not.toBeNull();

    gesture(ignored as Element, 240, 100);

    expect(useHomeStore.getState().ui.room).toBe('living');
    expect(surface.className).not.toContain('translate-x-1');
  });
});
