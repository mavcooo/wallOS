import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Floor } from '@/types/floorplan';

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({ sendAction: vi.fn() }),
}));

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

const { SchematicFloorCanvas } = await import('./SchematicFloorCanvas');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');

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
      gridLayout: { col: 6, row: 1, colSpan: 4, rowSpan: 3, color: 'teal' },
      devices: [
        {
          id: 'sensor-kitchen-smoke',
          name: 'Rilevatore fumo',
          kind: 'sensor',
          roomPinPosition: { x: 50, y: 50 },
        },
      ],
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
});

describe('SchematicFloorCanvas · planimetria generativa', () => {
  it('renderizza le stanze dalla griglia e i marker dai dati del piano', () => {
    const { container } = renderWithTopology(
      <SchematicFloorCanvas floor={FLOOR} onOpenDetail={vi.fn()} />,
      { topology: SEED_TOPOLOGY },
    );

    const living = container.querySelector('[data-room-block="living"]');
    expect(living).not.toBeNull();
    expect(living).toHaveAttribute('data-state', 'lit');
    expect(living?.getAttribute('style')).toContain('grid-column: 1 / span 5');

    const marker = screen.getByRole('button', { name: /Luce principale/ });
    expect(marker.style.left).toBe('40%');
    expect(marker.style.top).toBe('30%');

    // Media ambientale dal sensore del soggiorno (21.4 °C nel seed).
    expect(screen.getByText('21.4°C')).toBeInTheDocument();
  });

  it('riflette in tempo reale luci e allarmi sullo sfondo e sui blocchi', () => {
    const { container } = renderWithTopology(
      <SchematicFloorCanvas floor={FLOOR} onOpenDetail={vi.fn()} />,
      { topology: SEED_TOPOLOGY },
    );

    const section = container.querySelector('[aria-label="Planimetria del piano Piano terra"]');
    expect(section).toHaveAttribute('data-floor-lit');

    // Allarme fumo: il blocco cucina pulsa e lo sfondo segnala l'emergenza.
    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('sensor-kitchen-smoke', { kind: 'sensor', state: { value: true } });
    });

    expect(container.querySelector('[data-room-block="kitchen"]')).toHaveAttribute(
      'data-state',
      'alarm',
    );
    expect(section).toHaveAttribute('data-floor-alarm');

    // Spegnimento di tutte le luci: sparisce il bagliore ambra.
    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('light-living-main', { kind: 'light', state: { on: false } });
    });
    expect(container.querySelector('[data-room-block="living"]')).toHaveAttribute(
      'data-state',
      'idle',
    );
    expect(section).not.toHaveAttribute('data-floor-lit');
  });

  it('seleziona la stanza dal canvas', () => {
    const onSelectRoom = vi.fn();
    renderWithTopology(
      <SchematicFloorCanvas floor={FLOOR} onSelectRoom={onSelectRoom} onOpenDetail={vi.fn()} />,
      { topology: SEED_TOPOLOGY },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Seleziona Cucina' }));
    expect(onSelectRoom).toHaveBeenCalledWith('kitchen');
  });
});
