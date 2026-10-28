import { describe, expect, it } from 'vitest';

import {
  FLOORPLAN_GRID,
  firstFreeLayout,
  floorSignals,
  isSecurityAlarm,
  layoutsOverlap,
  moveRoomLayout,
  normalizeGridLayout,
  normalizePinPosition,
  resizeRoomLayout,
  roomSignals,
} from '@/lib/floorplan';
import type { DeviceRealtimeState, SensorType } from '@/types/device';
import type { Floor, RoomGridLayout } from '@/types/floorplan';

function light(on: boolean, id = 'light'): [string, DeviceRealtimeState] {
  return [
    id,
    {
      id,
      kind: 'light',
      state: { on, brightness: on ? 70 : 0 },
      availability: 'online',
      lastSeen: 1,
      favorite: false,
      isOptimistic: false,
      lastUpdated: 1,
      isAvailable: true,
    },
  ];
}

function sensor(
  type: SensorType,
  value: number | boolean,
  id = `sensor-${type}`,
): [string, DeviceRealtimeState] {
  return [
    id,
    {
      id,
      kind: 'sensor',
      state: { value, unit: '', type },
      availability: 'online',
      lastSeen: 1,
      favorite: false,
      isOptimistic: false,
      lastUpdated: 1,
      isAvailable: true,
    },
  ];
}

describe('geometria della planimetria', () => {
  it('normalizza una geometria fuori griglia dentro i limiti 12×8', () => {
    const layout = normalizeGridLayout({
      col: 11,
      row: 7,
      colSpan: 9,
      rowSpan: 6,
      color: 'amber',
    });

    expect(layout.color).toBe('amber');
    expect(layout.colSpan).toBe(9);
    expect(layout.col + layout.colSpan - 1).toBeLessThanOrEqual(FLOORPLAN_GRID.cols);
    expect(layout.row + layout.rowSpan - 1).toBeLessThanOrEqual(FLOORPLAN_GRID.rows);
  });

  it('ricade sui default per payload corrotti', () => {
    expect(normalizeGridLayout('nope')).toMatchObject({
      col: 1,
      row: 1,
      colSpan: 3,
      rowSpan: 2,
      color: 'zinc',
    });
    expect(normalizeGridLayout({ color: 'fucsia' }).color).toBe('zinc');
  });

  it('mantiene i marker in percentuale tra 0 e 100', () => {
    expect(normalizePinPosition({ x: -20, y: 140 })).toEqual({ x: 0, y: 100 });
    expect(normalizePinPosition({ x: 33.5, y: 66.5 })).toEqual({ x: 33.5, y: 66.5 });
  });

  it('sposta e ridimensiona senza uscire dalla griglia', () => {
    const layout: RoomGridLayout = { col: 1, row: 1, colSpan: 4, rowSpan: 3, color: 'zinc' };

    expect(moveRoomLayout(layout, -5, -5)).toMatchObject({ col: 1, row: 1 });
    expect(moveRoomLayout(layout, 50, 50)).toMatchObject({
      col: FLOORPLAN_GRID.cols - layout.colSpan + 1,
      row: FLOORPLAN_GRID.rows - layout.rowSpan + 1,
    });
    expect(resizeRoomLayout(layout, 50, 50)).toMatchObject({
      colSpan: FLOORPLAN_GRID.cols - layout.col + 1,
      rowSpan: FLOORPLAN_GRID.rows - layout.row + 1,
    });
    expect(resizeRoomLayout(layout, -50, -50)).toMatchObject({ colSpan: 1, rowSpan: 1 });
  });

  it('trova la prima cella libera evitando le stanze già presenti', () => {
    const occupied: RoomGridLayout[] = [
      { col: 1, row: 1, colSpan: 3, rowSpan: 2, color: 'zinc' },
    ];
    const free = firstFreeLayout(occupied);

    expect(layoutsOverlap(free, occupied[0] as RoomGridLayout)).toBe(false);
    expect(free).toMatchObject({ row: 1, colSpan: 3, rowSpan: 2 });
  });
});

describe('segnali di stanza e piano', () => {
  const devices = [
    { id: 'light', name: 'Luce', kind: 'light' as const, roomPinPosition: { x: 10, y: 10 } },
    { id: 'sensor-smoke', name: 'Fumo', kind: 'sensor' as const, roomPinPosition: { x: 20, y: 20 } },
    {
      id: 'sensor-temperature',
      name: 'Temperatura',
      kind: 'sensor' as const,
      roomPinPosition: { x: 30, y: 30 },
    },
  ];

  it('aggrega luci, allarmi e medie ambientali ignorando i valori assenti', () => {
    const states = Object.fromEntries([
      light(true, 'light'),
      sensor('smoke', true, 'sensor-smoke'),
      sensor('temperature', 21, 'sensor-temperature'),
    ]);

    const signals = roomSignals(devices, states);

    expect(signals.lightsOn).toBe(true);
    expect(signals.alarm).toBe(true);
    expect(signals.temperature).toBe(21);
    expect(signals.humidity).toBeNull();
  });

  it('considera in allarme solo fumo, contatti e movimento attivi', () => {
    expect(isSecurityAlarm(statesSensor('smoke', true))).toBe(true);
    expect(isSecurityAlarm(statesSensor('contact', true))).toBe(true);
    expect(isSecurityAlarm(statesSensor('motion', false))).toBe(false);
    expect(isSecurityAlarm(statesSensor('temperature', 120))).toBe(false);
    expect(isSecurityAlarm(undefined)).toBe(false);
  });

  it('conta luci accese e allarmi dell’intero piano', () => {
    const floor: Floor = {
      id: 'piano',
      name: 'Piano',
      levelOrder: 0,
      icon: 'Layers',
      rooms: [
        {
          id: 'living',
          label: 'Soggiorno',
          shortLabel: 'Soggiorno',
          icon: 'sofa',
          floorId: 'piano',
          gridLayout: { col: 1, row: 1, colSpan: 4, rowSpan: 3, color: 'amber' },
          devices,
        },
        {
          id: 'kitchen',
          label: 'Cucina',
          shortLabel: 'Cucina',
          icon: 'cooking-pot',
          floorId: 'piano',
          gridLayout: { col: 5, row: 1, colSpan: 4, rowSpan: 3, color: 'teal' },
          devices: [
            {
              id: 'light-2',
              name: 'Striscia',
              kind: 'light',
              roomPinPosition: { x: 50, y: 50 },
            },
          ],
        },
      ],
    };

    const states = Object.fromEntries([
      light(true, 'light'),
      light(false, 'light-2'),
      sensor('smoke', true, 'sensor-smoke'),
    ]);

    expect(floorSignals(floor, states)).toEqual({ lightsOn: 1, alarms: 1 });
    expect(floorSignals(undefined, states)).toEqual({ lightsOn: 0, alarms: 0 });
  });
});

function statesSensor(type: SensorType, value: boolean | number): DeviceRealtimeState {
  return sensor(type, value)[1];
}
