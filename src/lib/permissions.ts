import type { SessionUser, UserRole } from '@/types/user';

export type Permission = 'settings' | 'energy' | 'users' | 'sensitiveActions';

export interface Restrictions {
  settings: boolean;
  energy: boolean;
  users: boolean;
  sensitiveActions: boolean;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Amministratore',
  family: 'Famiglia',
  guest: 'Ospite',
  kiosk: 'Pannello Parete',
};

export const ROLE_TONE: Record<UserRole, 'accent' | 'success' | 'neutral' | 'warning'> = {
  admin: 'accent',
  family: 'success',
  guest: 'neutral',
  kiosk: 'warning',
};

/**
 * Restrizioni puramente di interfaccia: il server resta l'unica autorità.
 * Il kiosk sblocca impostazioni e utenti solo per la finestra di elevazione
 * PIN (5 minuti), mai energia o azioni distruttive senza PIN.
 */
const BASE_RESTRICTIONS: Record<UserRole, Restrictions> = {
  admin: { settings: false, energy: false, users: false, sensitiveActions: false },
  family: { settings: true, energy: false, users: true, sensitiveActions: true },
  guest: { settings: true, energy: true, users: true, sensitiveActions: true },
  kiosk: { settings: true, energy: false, users: true, sensitiveActions: true },
};

export function restrictionsFor(role: UserRole, elevated: boolean): Restrictions {
  const base = { ...BASE_RESTRICTIONS[role] };
  if (role === 'kiosk' && elevated) {
    base.settings = false;
    base.users = false;
  }
  return base;
}

export function canAccess(
  user: Pick<SessionUser, 'role'>,
  elevated: boolean,
  permission: Permission,
): boolean {
  return !restrictionsFor(user.role, elevated)[permission];
}

/** Navigazione bloccata già nella sidebar, non solo a vista aperta. */
export function canView(
  user: Pick<SessionUser, 'role'>,
  elevated: boolean,
  view: 'overview' | 'rooms' | 'energy' | 'settings' | 'users' | 'admin',
): boolean {
  switch (view) {
    case 'overview':
    case 'rooms':
      return true;
    case 'energy':
      return canAccess(user, elevated, 'energy');
    case 'settings':
      return canAccess(user, elevated, 'settings');
    case 'users':
      return canAccess(user, elevated, 'users');
    case 'admin':
      // La topologia si amministra solo da un profilo admin, mai da un kiosk
      // elevato: la scrittura sul DB è più delicata delle singole azioni.
      return user.role === 'admin';
  }
}
