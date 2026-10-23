import { create } from 'zustand';

import i18n from '@/i18n';
import { ApiError, authApi } from '@/lib/authApi';
import type {
  PinPolicy,
  SessionEnvelope,
  SessionUser,
  VerifyPinResult,
} from '@/types/user';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthState {
  user: SessionUser | null;
  status: AuthStatus;
  /** Policy mostrata dalla UI: l'enforcement resta sul server. */
  pinPolicy: PinPolicy;
  elevated: boolean;
  elevatedUntil: number | null;
  temporary: boolean;
  error: string | null;
  users: SessionUser[];

  bootstrap(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  loginKiosk(deviceId: string, pin: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<boolean>;
  verifyPin(pin: string): Promise<VerifyPinResult>;
  changePin(newPin: string): Promise<void>;
  switchUser(userId: string, pin: string): Promise<void>;
  loadUsers(): Promise<void>;
  setUserActive(userId: string, active: boolean): Promise<void>;
  markAnonymous(): void;
  clearElevation(): void;
  clearError(): void;
}

const PLACEHOLDER_POLICY: PinPolicy = {
  minLength: 4,
  maxLength: 6,
  maxAttempts: 3,
  lockoutMs: 60_000,
};

const anonymousState = {
  user: null,
  status: 'anonymous' as const,
  elevated: false,
  elevatedUntil: null,
  temporary: false,
};

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.retryAfterMs && error.retryAfterMs > 0) {
      return `${error.message} · ${i18n.t('lock.retryAfter', {
        ns: 'auth',
        seconds: Math.ceil(error.retryAfterMs / 1000),
      })}`;
    }
    if (error.message) return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return i18n.t('errors.unexpected');
}

let bootstrapInFlight: Promise<void> | null = null;

export const useAuthStore = create<AuthState>()((set, get) => {
  const applySession = (envelope: SessionEnvelope): void => {
    set({
      user: envelope.user,
      status: 'authenticated',
      pinPolicy: envelope.pinPolicy,
      elevated: envelope.elevated,
      elevatedUntil: envelope.elevatedUntil,
      temporary: envelope.temporary,
      error: null,
    });
  };

  return {
    user: null,
    status: 'loading',
    pinPolicy: PLACEHOLDER_POLICY,
    elevated: false,
    elevatedUntil: null,
    temporary: false,
    error: null,
    users: [],

    bootstrap() {
      if (bootstrapInFlight) return bootstrapInFlight;
      if (get().status === 'authenticated' && get().user) return Promise.resolve();

      bootstrapInFlight = (async () => {
        try {
          applySession(await authApi.me());
        } catch (error) {
          // L'access token dura 15 minuti: al riavvio del tablet si usa il
          // refresh HttpOnly (kiosk: 90 giorni) senza reinserire credenziali.
          const refreshed = await authApi.refresh();
          if (refreshed) {
            applySession(refreshed);
            return;
          }
          set({
            ...anonymousState,
            error:
              error instanceof ApiError && error.status === 401
                ? null
                : 'Servizio di autenticazione non raggiungibile',
          });
        }
      })().finally(() => {
        bootstrapInFlight = null;
      });

      return bootstrapInFlight;
    },

    async login(username, password) {
      set({ error: null });
      try {
        applySession(await authApi.login(username, password));
      } catch (error) {
        set({ error: describeError(error) });
      }
    },

    async loginKiosk(deviceId, pin) {
      set({ error: null });
      try {
        applySession(await authApi.kioskSession(deviceId, pin));
      } catch (error) {
        set({ error: describeError(error) });
      }
    },

    async logout() {
      await authApi.logout();
      set({ ...anonymousState, users: [], error: null });
    },

    async refresh() {
      const envelope = await authApi.refresh();
      if (!envelope) {
        set(anonymousState);
        return false;
      }
      applySession(envelope);
      return true;
    },

    async verifyPin(pin) {
      const result = await authApi.verifyPin(pin);
      if (result.ok) {
        set({
          elevated: true,
          elevatedUntil: result.elevatedUntil ?? Date.now() + 5 * 60_000,
        });
      }
      return result;
    },

    async changePin(newPin) {
      await authApi.changePin(newPin);
      // Il PIN è cambiato: lunghezza aggiornata e elevazione consumata.
      applySession(await authApi.me());
      set({ elevated: false, elevatedUntil: null });
    },

    async switchUser(userId, pin) {
      applySession(await authApi.switchProfile(userId, pin));
    },

    async loadUsers() {
      const { users } = await authApi.listUsers();
      set({ users });
    },

    async setUserActive(userId, active) {
      const { user } = await authApi.setUserActive(userId, active);
      set((state) => ({
        users: state.users.map((candidate) =>
          candidate.id === user.id ? user : candidate,
        ),
      }));
    },

    markAnonymous() {
      set({ ...anonymousState, users: [], error: 'Sessione scaduta' });
    },

    clearElevation() {
      set({ elevated: false, elevatedUntil: null });
    },

    clearError() {
      set({ error: null });
    },
  };
});

export const selectIsAuthenticated = (state: AuthState): boolean =>
  state.status === 'authenticated';
export const selectIsLoading = (state: AuthState): boolean => state.status === 'loading';
