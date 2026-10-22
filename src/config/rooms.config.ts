import type { RoomId } from '@/types/device';

export interface RoomConfig {
  id: RoomId;
  label: string;
  shortLabel: string;
}

export const ROOMS: readonly RoomConfig[] = [
  { id: 'living', label: 'Soggiorno', shortLabel: 'Soggiorno' },
  { id: 'kitchen', label: 'Cucina', shortLabel: 'Cucina' },
  { id: 'bedroom', label: 'Camera', shortLabel: 'Camera' },
  { id: 'study', label: 'Studio', shortLabel: 'Studio' },
  { id: 'bath', label: 'Bagno', shortLabel: 'Bagno' },
  { id: 'outdoor', label: 'Esterno', shortLabel: 'Esterno' },
];

export const ROOM_LABELS: Record<RoomId, string> = {
  living: 'Soggiorno',
  kitchen: 'Cucina',
  bedroom: 'Camera',
  study: 'Studio',
  bath: 'Bagno',
  outdoor: 'Esterno',
};
