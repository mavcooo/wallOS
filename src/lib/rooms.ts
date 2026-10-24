import type { RoomId } from '@/types/device';

export interface RoomConfig {
  id: RoomId;
  label: string;
  shortLabel: string;
  /** Metadati gestiti dall'amministrazione (non usati dai widget). */
  icon?: string;
  displayOrder?: number;
}

/** Stanza di fallback per le entità scoperte senza `suggested_area`. */
export const UNASSIGNED_ROOM_ID = 'unassigned';

/**
 * Le stanze arrivano da PostgreSQL (`GET /api/topology`). Discovery HA può
 * aggiungerne altre a runtime nella cache della topologia (`lib/discovery.ts`):
 * qui restano solo le funzioni pure condivise da hook, header e widget.
 */

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
