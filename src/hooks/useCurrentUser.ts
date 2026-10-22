import { useHomeStore } from '@/store/homeStore';
import type { LocalUser } from '@/config/users.config';

export function useCurrentUser(): LocalUser {
  return useHomeStore((state) => {
    const found = state.users.find((user) => user.id === state.ui.activeUserId);
    return (
      found ??
      state.users.find((user) => user.role === 'panel') ??
      state.users[0] ?? {
        id: 'fallback',
        name: 'Pannello',
        initials: 'PN',
        role: 'panel',
        allowedRooms: null,
        restrictions: {
          settings: false,
          energy: false,
          users: true,
          sensitiveActions: true,
        },
        lastAccess: null,
        active: true,
      }
    );
  });
}
