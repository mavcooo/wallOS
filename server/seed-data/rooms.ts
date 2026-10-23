export interface SeedRoom {
  id: string;
  name: string;
  shortLabel: string;
  icon: string;
  displayOrder: number;
}

/** ID stabili: sono referenziati da MQTT, scenari e discovery HA. */
export const SEED_ROOMS: readonly SeedRoom[] = [
  { id: 'living', name: 'Soggiorno', shortLabel: 'Soggiorno', icon: 'sofa', displayOrder: 0 },
  { id: 'kitchen', name: 'Cucina', shortLabel: 'Cucina', icon: 'cooking-pot', displayOrder: 1 },
  { id: 'bedroom', name: 'Camera', shortLabel: 'Camera', icon: 'bed-double', displayOrder: 2 },
  { id: 'study', name: 'Studio', shortLabel: 'Studio', icon: 'laptop', displayOrder: 3 },
  { id: 'bath', name: 'Bagno', shortLabel: 'Bagno', icon: 'bath', displayOrder: 4 },
  { id: 'outdoor', name: 'Esterno', shortLabel: 'Esterno', icon: 'trees', displayOrder: 5 },
  {
    id: 'unassigned',
    name: 'Non assegnati',
    shortLabel: 'Altro',
    icon: 'inbox',
    displayOrder: 6,
  },
];
