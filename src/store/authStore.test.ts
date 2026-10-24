import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEnvelope, SessionUser } from '@/types/user';

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly retryAfterMs?: number;

    constructor(status: number, code: string, message: string, retryAfterMs?: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.retryAfterMs = retryAfterMs;
    }
  }

  return {
    ApiError,
    api: {
      login: vi.fn(),
      kioskSession: vi.fn(),
      me: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
      verifyPin: vi.fn(),
      changePin: vi.fn(),
      switchProfile: vi.fn(),
      listUsers: vi.fn(),
      setUserActive: vi.fn(),
    },
  };
});

vi.mock('@/lib/authApi', () => ({
  authApi: mocks.api,
  ApiError: mocks.ApiError,
}));

const { useAuthStore } = await import('@/store/authStore');

const ADMIN: SessionUser = {
  id: 'user-admin',
  username: 'admin',
  name: 'Amministratore',
  initials: 'AM',
  role: 'admin',
  allowedRooms: null,
  active: true,
  isKioskDevice: false,
  kioskDeviceId: null,
  lastAccess: 'adesso',
  pinLength: 4,
};

const FAMILY: SessionUser = {
  id: 'user-family',
  username: 'family',
  name: 'Giulia Conti',
  initials: 'GC',
  role: 'family',
  allowedRooms: ['living'],
  active: true,
  isKioskDevice: false,
  kioskDeviceId: null,
  lastAccess: 'ieri',
  pinLength: 4,
};

const PIN_POLICY = { minLength: 4, maxLength: 6, maxAttempts: 3, lockoutMs: 60_000 };

function envelope(user: SessionUser, patch: Partial<SessionEnvelope> = {}): SessionEnvelope {
  return {
    user,
    pinPolicy: PIN_POLICY,
    elevated: false,
    elevatedUntil: null,
    temporary: false,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: null,
    status: 'loading',
    pinPolicy: PIN_POLICY,
    elevated: false,
    elevatedUntil: null,
    temporary: false,
    error: null,
    users: [],
  });
});

describe('authStore', () => {
  it('applica la sessione restituita dal login', async () => {
    mocks.api.login.mockResolvedValue(envelope(ADMIN));

    await useAuthStore.getState().login('admin', 'password');

    const state = useAuthStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.user).toMatchObject({ id: ADMIN.id, role: 'admin' });
    expect(state.pinPolicy).toEqual(PIN_POLICY);
    expect(state.error).toBeNull();
  });

  it('al bootstrap usa il refresh quando l’access token è scaduto', async () => {
    mocks.api.me.mockRejectedValue(
      new mocks.ApiError(401, 'UNAUTHENTICATED', 'Sessione scaduta'),
    );
    mocks.api.refresh.mockResolvedValue(envelope(FAMILY));

    await useAuthStore.getState().bootstrap();

    expect(mocks.api.refresh).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user?.role).toBe('family');
  });

  it('senza access e refresh validi torna anonimo', async () => {
    mocks.api.me.mockRejectedValue(
      new mocks.ApiError(401, 'UNAUTHENTICATED', 'Sessione scaduta'),
    );
    mocks.api.refresh.mockResolvedValue(null);

    await useAuthStore.getState().bootstrap();

    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('marca l’elevazione solo quando il server conferma il PIN', async () => {
    mocks.api.verifyPin.mockResolvedValue({
      ok: true,
      locked: false,
      retryAfterMs: 0,
      remainingAttempts: 3,
      lockedUntil: null,
      elevatedUntil: Date.now() + 5 * 60_000,
    });

    const result = await useAuthStore.getState().verifyPin('2468');

    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().elevated).toBe(true);
    expect(useAuthStore.getState().elevatedUntil).toEqual(expect.any(Number));

    mocks.api.verifyPin.mockResolvedValue({
      ok: false,
      locked: false,
      retryAfterMs: 0,
      remainingAttempts: 2,
      lockedUntil: null,
    });
    await useAuthStore.getState().verifyPin('0000');
    // Un errore non deve revocare un'elevazione già valida.
    expect(useAuthStore.getState().elevated).toBe(true);
  });

  it('il cambio profilo applica la sessione temporanea', async () => {
    mocks.api.switchProfile.mockResolvedValue(envelope(FAMILY, { temporary: true }));

    await useAuthStore.getState().switchUser(FAMILY.id, '1234');

    expect(useAuthStore.getState().user?.id).toBe(FAMILY.id);
    expect(useAuthStore.getState().temporary).toBe(true);
  });

  it('il cambio PIN aggiorna la policy e consuma l’elevazione', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: ADMIN,
      elevated: true,
      elevatedUntil: Date.now() + 1_000,
    });
    mocks.api.changePin.mockResolvedValue(undefined);
    mocks.api.me.mockResolvedValue(envelope({ ...ADMIN, pinLength: 6 }));

    await useAuthStore.getState().changePin('123456');

    expect(useAuthStore.getState().user?.pinLength).toBe(6);
    expect(useAuthStore.getState().elevated).toBe(false);
  });

  it('il logout azzera utente e profili', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: ADMIN,
      users: [ADMIN, FAMILY],
    });
    mocks.api.logout.mockResolvedValue(undefined);

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().users).toEqual([]);
  });

  it('propaga la disattivazione di un profilo nella lista', async () => {
    useAuthStore.setState({ users: [ADMIN, FAMILY] });
    mocks.api.setUserActive.mockResolvedValue({
      user: { ...FAMILY, active: false },
    });

    await useAuthStore.getState().setUserActive(FAMILY.id, false);

    expect(useAuthStore.getState().users.find((user) => user.id === FAMILY.id)?.active).toBe(
      false,
    );
  });
});
