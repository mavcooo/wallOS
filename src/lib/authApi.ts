import i18n from '@/i18n';
import type {
  SessionEnvelope,
  SessionUser,
  VerifyPinResult,
} from '@/types/user';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs?: number;
  readonly remainingAttempts?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterMs?: number,
    remainingAttempts?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.remainingAttempts = remainingAttempts;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Evita loop su /auth/* e consente alla verifica PIN di leggere il 403. */
  retryOn401?: boolean;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function toApiError(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof data?.error === 'string' ? data.error : 'HTTP_ERROR';
  const message =
    typeof data?.message === 'string'
      ? data.message
      : i18n.t('errors.http', { status: response.status });
  return new ApiError(
    response.status,
    code,
    message,
    data ? numberField(data, 'retryAfterMs') : undefined,
    data ? numberField(data, 'remainingAttempts') : undefined,
  );
}

async function execute<T>(path: string, options: RequestOptions): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

let refreshInFlight: Promise<SessionEnvelope | null> | null = null;

/**
 * Una sola rotazione refresh alla volta: due chiamate concorrenti con lo
 * stesso token verrebbero viste dal server come riuso (token theft).
 */
export function refreshSession(): Promise<SessionEnvelope | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      return await execute<SessionEnvelope>('/auth/refresh', {
        method: 'POST',
        retryOn401: false,
      });
    } catch {
      return null;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

function canRefreshOn401(path: string): boolean {
  // Login/kiosk-session/refresh/logout non devono innescare un refresh:
  // un 401 lì significa credenziali o sessione già invalidate.
  return (
    path === '/auth/verify-pin' ||
    path === '/auth/pin' ||
    path === '/auth/switch-profile' ||
    path.startsWith('/auth/users')
  );
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await execute<T>(path, options);
  } catch (error) {
    const canRetry =
      error instanceof ApiError &&
      error.status === 401 &&
      options.retryOn401 !== false &&
      canRefreshOn401(path);
    if (!canRetry) throw error;

    const refreshed = await refreshSession();
    if (!refreshed) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('domus:auth-expired'));
      }
      throw error;
    }
    return execute<T>(path, { ...options, retryOn401: false });
  }
}

export const authApi = {
  login(username: string, password: string): Promise<SessionEnvelope> {
    return request('/auth/login', { method: 'POST', body: { username, password } });
  },

  kioskSession(deviceId: string, pin: string): Promise<SessionEnvelope> {
    return request('/auth/kiosk-session', { method: 'POST', body: { deviceId, pin } });
  },

  me(): Promise<SessionEnvelope> {
    return request('/auth/me', { retryOn401: false });
  },

  refresh: refreshSession,

  async logout(): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST', retryOn401: false });
    } catch {
      // Il logout locale deve riuscire anche se il gateway è irraggiungibile.
    }
  },

  verifyPin(pin: string): Promise<VerifyPinResult> {
    return request('/auth/verify-pin', { method: 'POST', body: { pin } });
  },

  changePin(newPin: string, currentPin?: string): Promise<void> {
    return request('/auth/pin', {
      method: 'POST',
      body: { newPin, ...(currentPin ? { currentPin } : {}) },
    });
  },

  switchProfile(userId: string, pin: string): Promise<SessionEnvelope> {
    return request('/auth/switch-profile', { method: 'POST', body: { userId, pin } });
  },

  listUsers(): Promise<{ users: SessionUser[] }> {
    return request('/auth/users');
  },

  setUserActive(userId: string, active: boolean): Promise<{ user: SessionUser }> {
    return request(`/auth/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { active },
    });
  },
};
