import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Floor } from '@/types/floorplan';

const mocks = vi.hoisted(() => ({
  saveLayout: vi.fn(async () => ({}) as unknown),
  createFloor: vi.fn(async () => ({}) as unknown),
  updateFloor: vi.fn(async () => ({}) as unknown),
  deleteFloor: vi.fn(async () => undefined),
}));

vi.mock('@/lib/floorplanApi', () => ({
  fetchFloors: vi.fn(async () => []),
  parseFloors: vi.fn(() => []),
  floorplanApi: {
    saveLayout: mocks.saveLayout,
    createFloor: mocks.createFloor,
    updateFloor: mocks.updateFloor,
    deleteFloor: mocks.deleteFloor,
  },
}));

const { FloorplanEditor } = await import('./FloorplanEditor');
const { useHomeStore } = await import('@/store/homeStore');
const { FLOORPLAN_QUERY_KEY } = await import('@/lib/queryClient');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { createTestQueryClient, renderWithTopology } = await import('@/test/query');

const FLOOR: Floor = {
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
        {
          id: 'sensor-living-temp',
          name: 'Temperatura soggiorno',
          kind: 'sensor',
          roomPinPosition: { x: 70, y: 60 },
        },
      ],
    },
    {
      id: 'kitchen',
      label: 'Cucina',
      shortLabel: 'Cucina',
      icon: 'cooking-pot',
      floorId: 'piano-terra',
      gridLayout: { col: 6, row: 1, colSpan: 4, rowSpan: 2, color: 'teal' },
      devices: [],
    },
  ],
};

function renderEditor() {
  const client = createTestQueryClient();
  client.setQueryData(FLOORPLAN_QUERY_KEY, [FLOOR]);
  return renderWithTopology(<FloorplanEditor />, { topology: SEED_TOPOLOGY, client });
}

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
  for (const mock of Object.values(mocks)) mock.mockClear();
});

describe('FloorplanEditor · modifica e salvataggio', () => {
  it('mostra la griglia con le stanze del piano e i marker dei dispositivi', () => {
    const { container } = renderEditor();

    const living = container.querySelector('[data-editor-room="living"]');
    // Ogni stanza è la sua griglia secondaria (span) della matrice 12×8.
    expect(living?.getAttribute('style')).toContain('grid-column: 1 / span 5');

    expect(
      screen.getByRole('button', { name: 'Marker di Luce principale' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salva layout' })).toBeDisabled();
  });

  it('sposta con lo snap-to-grid e salva geometrie e marker in un solo payload', async () => {
    const { container } = renderEditor();
    const living = container.querySelector('[data-editor-room="living"]') as HTMLElement;

    // Tastiera: una cella a destra (snap-to-grid, bounds-safe).
    fireEvent.keyDown(living, { key: 'ArrowRight' });

    expect(living.getAttribute('style')).toContain('grid-column: 2 / span 5');
    expect(screen.getByText('Modifiche non salvate')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Salva layout' }));

    await waitFor(() => expect(mocks.saveLayout).toHaveBeenCalledTimes(1));

    const [floorId, payload] = mocks.saveLayout.mock.calls[0] as unknown as [
      string,
      {
        rooms: { id: string; floorId: string | null; gridLayout: { col: number } }[];
        devices: { id: string; roomPinPosition: { x: number; y: number } }[];
      },
    ];

    expect(floorId).toBe('piano-terra');
    expect(payload.rooms.map((room) => room.id)).toEqual(['living', 'kitchen']);
    expect(payload.rooms[0]).toMatchObject({
      floorId: 'piano-terra',
      gridLayout: { col: 2, row: 1, colSpan: 5, rowSpan: 4, color: 'amber' },
    });
    // Cucina non ha dispositivi nel piano ma i marker del soggiorno sì.
    expect(payload.devices).toEqual(
      expect.arrayContaining([
        { id: 'light-living-main', roomPinPosition: { x: 40, y: 30 } },
        { id: 'sensor-living-temp', roomPinPosition: { x: 70, y: 60 } },
      ]),
    );
  });

  it('aggiunge una stanza dalla lista con una posizione libera', async () => {
    const { container } = renderEditor();

    const available = screen.getByRole('heading', { name: 'Altre stanze' }).parentElement;
    expect(available).not.toBeNull();
    const bathRow = within(available as HTMLElement)
      .getByText('Bagno')
      .closest('li');
    fireEvent.click(within(bathRow as HTMLElement).getByRole('button', { name: /Aggiungi/ }));

    await waitFor(() =>
      expect(container.querySelectorAll('[data-editor-room]')).toHaveLength(3),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Salva layout' }));
    await waitFor(() => expect(mocks.saveLayout).toHaveBeenCalledTimes(1));

    const payload = (mocks.saveLayout.mock.calls[0] as unknown as [string, { rooms: { id: string }[] }])[1];
    expect(payload.rooms.map((room) => room.id)).toContain('bath');
  });
});
