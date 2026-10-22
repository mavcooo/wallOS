import { restrictionsFor, type Restrictions } from '@/lib/permissions';
import { useAuthStore } from '@/store/authStore';
import type { SessionUser } from '@/types/user';

export interface CurrentUser extends SessionUser {
  elevated: boolean;
  restrictions: Restrictions;
}

/**
 * Profilo della sessione corrente. Va usato solo sotto <AuthGate>: qui non
 * esiste più alcun fallback hardcoded, perché un utente senza sessione non
 * deve vedere né dati né viste.
 */
export function useCurrentUser(): CurrentUser {
  const user = useAuthStore((state) => state.user);
  const elevated = useAuthStore((state) => state.elevated);

  if (!user) {
    throw new Error('useCurrentUser richiede una sessione autenticata (AuthGate)');
  }

  return {
    ...user,
    elevated,
    restrictions: restrictionsFor(user.role, elevated),
  };
}
