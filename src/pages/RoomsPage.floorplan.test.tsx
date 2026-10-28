import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Floor } from '@/types/floorplan';

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({ sendAction: vi.fn() }),
}));

const { RoomsPage } = await import('@/pages/RoomsPage');
const { useAuthStore } = await import('@/store/authStore');
const { useHomeStore } = await import('@/store/homeStore');
const { FLOORPLAN_QUERY_KEY } = await import('@/lib/queryClient');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { createTestQueryClient, renderWithTopology } = await import('@/test/query');

const FLOORS: Floor[] = [
  {
    id: 'piano-terra',
    name: 'Piano terra',
    levelOrder: 0,
    icon: 'Layers',
    rooms: [
      {
        id: 'living',
        label: 'Soggiorno',
        shortLabel: 'Soggiorno',
        icon: 'sofa',
        floorId: 'piano-terra',
        gridLayout: { col: 1, row: 1, colSpan: 5, rowSpan: 4, color: 'amber' },
        devices: [
          {
            id: 'light-living-main',
            name: 'Luce principale',
            kind: 'light',
            roomPinPosition: { x: 40, y: 30 },
          },
        ],
      },
    ],
  },
  {
    id: 'primo-piano',
    name: 'Primo piano',
    levelOrder: 1,
    icon: 'Building2',
    rooms: [
      {
        id: 'bedroom',
        label: 'Camera',
        shortLabel: 'Camera',
        icon: 'bed-double',
        floorId: 'primo-piano',
        gridLayout: { col: 1, row: 1, colSpan: 5, rowSpan: 3, color: 'rose' },
        devices: [],
      },
    ],
  },
];

function renderRooms() {
  const client = createTestQueryClient();
  client.setQueryData(FLOORPLAN_QUERY_KEY, FLOORS);
  return renderWithTopology(<RoomsPage />, { topology: SEED_TOPOLOGY, client });
}

beforeEach(() => {
  localStorage.clear();
  useHomeStore.getState().setRoom('living');
  useHomeStore.getState().setRoomView('grid');
  useHomeStore.getState().setFloor(null);
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

describe('RoomsPage · vista schematica', () => {
  it('il toggle passa alla pianta e persiste la preferenza nello store', () => {
    const { container } = renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Pianta' }));

    expect(useHomeStore.getState().ui.roomView).toBe('schematic');
    expect(screen.getByRole('tablist', { name: 'Selettore dei piani' })).toBeInTheDocument();
    expect(container.querySelector('[data-room-block="living"]')).not.toBeNull();
    expect(container.querySelector('[data-room-view="schematic"]')).not.toBeNull();

    // Il selettore delle tab stanza lascia il posto a quello dei piani.
    expect(screen.queryByRole('tab', { name: 'Cucina' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Griglia' }));
    expect(useHomeStore.getState().ui.roomView).toBe('grid');
    expect(screen.getByRole('tab', { name: 'Cucina' })).toBeInTheDocument();
  });

  it('cambia piano in modo sincrono e mostra le stanze di quel livello', () => {
    const { container } = renderRooms();
    fireEvent.click(screen.getByRole('button', { name: 'Pianta' }));

    expect(container.querySelector('[data-room-block="bedroom"]')).toBeNull();
    expect(useHomeStore.getState().ui.floor).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Primo piano/ }));

    // Cambio immediato: i dati dei piani sono già in cache, nessun fetch.
    expect(useHomeStore.getState().ui.floor).toBe('primo-piano');
    expect(container.querySelector('[data-room-block="bedroom"]')).not.toBeNull();
    expect(container.querySelector('[data-room-block="living"]')).toBeNull();
  });

  it('sulla pianta lo swipe pagina non cambia stanza', () => {
    const { container } = renderRooms();
    fireEvent.click(screen.getByRole('button', { name: 'Pianta' }));

    const surface = screen.getByTestId('rooms-swipe-surface');
    fireEvent.touchStart(surface, {
      touches: [{ clientX: 240, clientY: 120, identifier: 1 }],
    });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 100, clientY: 120, identifier: 1 }],
    });
    fireEvent.touchEnd(surface, { touches: [] });

    expect(useHomeStore.getState().ui.room).toBe('living');
    expect(container.querySelector('[data-room-block="living"]')).not.toBeNull();
  });
});
