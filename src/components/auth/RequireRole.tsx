import type { ReactNode } from 'react';

import { useAuthStore } from '@/store/authStore';
import type { UserRole } from '@/types/user';

export interface RequireRoleProps {
  role?: UserRole;
  roles?: readonly UserRole[];
  /** Il kiosk può accedere solo durante la finestra di elevazione PIN. */
  allowElevated?: boolean;
  fallback?: ReactNode;
  children: ReactNode;
}

export function RequireRole({
  role,
  roles,
  allowElevated = false,
  fallback = null,
  children,
}: RequireRoleProps) {
  const user = useAuthStore((state) => state.user);
  const elevated = useAuthStore((state) => state.elevated);

  if (!user) return <>{fallback}</>;

  const allowedRoles = roles ?? (role ? [role] : []);
  const allowed =
    allowedRoles.includes(user.role) ||
    (allowElevated && elevated && user.role === 'kiosk');

  return allowed ? <>{children}</> : <>{fallback}</>;
}
