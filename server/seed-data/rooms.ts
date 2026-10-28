import type { RoomGridLayout } from '../../src/types/floorplan.js';

export interface SeedRoom {
  id: string;
  name: string;
  shortLabel: string;
  icon: string;
  displayOrder: number;
  /** Piano della planimetria (`server/seed-data/floors.ts`). */
  floorId: string;
  /** Rettangolo sulla griglia 12×8, già disposto senza sovrapposizioni. */
  gridLayout: RoomGridLayout;
}

/** ID stabili: sono referenziati da MQTT, scenari e discovery HA. */
export const SEED_ROOMS: readonly SeedRoom[] = [
  {
    id: 'living',
    name: 'Soggiorno',
    shortLabel: 'Soggiorno',
    icon: 'sofa',
    displayOrder: 0,
    floorId: 'piano-terra',
    gridLayout: { col: 1, row: 1, colSpan: 5, rowSpan: 4, color: 'amber' },
  },
  {
    id: 'kitchen',
    name: 'Cucina',
    shortLabel: 'Cucina',
    icon: 'cooking-pot',
    displayOrder: 1,
    floorId: 'piano-terra',
    gridLayout: { col: 6, row: 1, colSpan: 4, rowSpan: 2, color: 'teal' },
  },
  {
    id: 'outdoor',
    name: 'Esterno',
    shortLabel: 'Esterno',
    icon: 'trees',
    displayOrder: 5,
    floorId: 'piano-terra',
    gridLayout: { col: 6, row: 3, colSpan: 4, rowSpan: 2, color: 'sky' },
  },
  {
    id: 'unassigned',
    name: 'Non assegnati',
    shortLabel: 'Altro',
    icon: 'inbox',
    displayOrder: 6,
    floorId: 'piano-terra',
    gridLayout: { col: 10, row: 1, colSpan: 3, rowSpan: 2, color: 'zinc' },
  },
  {
    id: 'bedroom',
    name: 'Camera',
    shortLabel: 'Camera',
    icon: 'bed-double',
    displayOrder: 2,
    floorId: 'primo-piano',
    gridLayout: { col: 1, row: 1, colSpan: 5, rowSpan: 3, color: 'rose' },
  },
  {
    id: 'study',
    name: 'Studio',
    shortLabel: 'Studio',
    icon: 'laptop',
    displayOrder: 3,
    floorId: 'primo-piano',
    gridLayout: { col: 6, row: 1, colSpan: 3, rowSpan: 3, color: 'sky' },
  },
  {
    id: 'bath',
    name: 'Bagno',
    shortLabel: 'Bagno',
    icon: 'bath',
    displayOrder: 4,
    floorId: 'primo-piano',
    gridLayout: { col: 9, row: 1, colSpan: 4, rowSpan: 3, color: 'teal' },
  },
];
