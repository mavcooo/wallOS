import type { RoomId } from '@/types/device';

export type UserRole = 'admin' | 'panel' | 'standard' | 'guest';

export interface LocalUser {
  id: string;
  name: string;
  initials: string;
  role: UserRole;
  /** `null` = tutte le stanze. */
  allowedRooms: RoomId[] | null;
  restrictions: {
    settings: boolean;
    energy: boolean;
    users: boolean;
    sensitiveActions: boolean;
  };
  lastAccess: string | null;
  active: boolean;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Amministratore',
  panel: 'Pannello Parete',
  standard: 'Utente',
  guest: 'Ospite',
};

export const DEFAULT_USERS: readonly LocalUser[] = [
  {
    id: 'user-panel',
    name: 'Pannello Parete',
    initials: 'PP',
    role: 'panel',
    allowedRooms: null,
    restrictions: { settings: false, energy: false, users: true, sensitiveActions: true },
    lastAccess: 'Sessione attiva',
    active: true,
  },
  {
    id: 'user-admin',
    name: 'Marco Bellini',
    initials: 'MB',
    role: 'admin',
    allowedRooms: null,
    restrictions: { settings: false, energy: false, users: false, sensitiveActions: false },
    lastAccess: '2 ore fa',
    active: true,
  },
  {
    id: 'user-standard',
    name: 'Giulia Conti',
    initials: 'GC',
    role: 'standard',
    allowedRooms: ['living', 'kitchen', 'bedroom', 'bath'],
    restrictions: { settings: true, energy: false, users: true, sensitiveActions: true },
    lastAccess: 'Ieri, 21:40',
    active: true,
  },
  {
    id: 'user-guest',
    name: 'Ospite',
    initials: 'OS',
    role: 'guest',
    allowedRooms: ['living', 'kitchen'],
    restrictions: { settings: true, energy: true, users: true, sensitiveActions: true },
    lastAccess: '12 giorni fa',
    active: false,
  },
];
