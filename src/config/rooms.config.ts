import type { RoomId } from '@/types/device';

export interface RoomConfig {
  id: RoomId;
  label: string;
  shortLabel: string;
}

/** Stanza di fallback per le entità scoperte senza `suggested_area`. */
export const UNASSIGNED_ROOM_ID = 'unassigned';

/**
 * Seed delle stanze. Restano la base della dashboard, ma non sono più l'unica
 * fonte: Home Assistant MQTT Discovery può aggiungerne altre a runtime
 * (`ensureRoom` nello store).
 */
export const ROOMS: readonly RoomConfig[] = [
  { id: 'living', label: 'Soggiorno', shortLabel: 'Soggiorno' },
  { id: 'kitchen', label: 'Cucina', shortLabel: 'Cucina' },
  { id: 'bedroom', label: 'Camera', shortLabel: 'Camera' },
  { id: 'study', label: 'Studio', shortLabel: 'Studio' },
  { id: 'bath', label: 'Bagno', shortLabel: 'Bagno' },
  { id: 'outdoor', label: 'Esterno', shortLabel: 'Esterno' },
  { id: UNASSIGNED_ROOM_ID, label: 'Non assegnati', shortLabel: 'Altro' },
];

/** `Soggiorno` → `soggiorno`, `Bagno 2° piano` → `bagno-2-piano`. */
export function roomIdFromLabel(label: string): RoomId {
  const slug = label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || UNASSIGNED_ROOM_ID;
}

/**
 * Etichetta di una stanza. Le stanze sono dinamiche: se l'id non è (ancora)
 * nello store si mostra l'id, mai `undefined`.
 */
export function roomLabel(rooms: readonly RoomConfig[], id: RoomId): string {
  return rooms.find((room) => room.id === id)?.label ?? id;
}
