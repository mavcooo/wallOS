import i18n from '@/i18n';
import { ApiError, refreshSession } from '@/lib/authApi';
import type {
  ClimateOverrideRequest,
  ClimateRuntimeState,
  ClimateSchedule,
  ClimateScheduleInput,
  ClimateScheduleResponse,
} from '@/types/climate';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

async function toApiError(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof data?.error === 'string' ? data.error : 'HTTP_ERROR';
  const message =
    typeof data?.message === 'string'
      ? data.message
      : i18n.t('errors.http', { status: response.status });
  return new ApiError(response.status, code, message);
}

function send(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
  });
}

/**
 * Richiesta autenticata: se l'access token è scaduto si tenta una sola
 * rotazione del refresh, come per le altre API del pannello.
 */
async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response = await send(path, init);
  if (response.status === 401 && (await refreshSession())) {
    response = await send(path, init);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Cronotermostato: il server è l'unica fonte di verità del programma, il
 * motore che pubblica i setpoint vive lì (job al minuto). Il pannello legge,
 * salva, e registra gli override manuali che ha già inviato sul broker.
 */
export const climateApi = {
  getSchedule(deviceId: string): Promise<ClimateScheduleResponse> {
    return request(`/climate/${encodeURIComponent(deviceId)}/schedules`, { method: 'GET' });
  },

  saveSchedules(
    deviceId: string,
    schedules: readonly ClimateScheduleInput[],
  ): Promise<{ schedules: ClimateSchedule[] }> {
    return request(
      `/climate/${encodeURIComponent(deviceId)}/schedules`,
      jsonBody({ schedules }),
    );
  },

  setOverride(
    deviceId: string,
    override: ClimateOverrideRequest,
  ): Promise<{ runtime: ClimateRuntimeState }> {
    return request(`/climate/${encodeURIComponent(deviceId)}/override`, jsonBody(override));
  },

  clearOverride(deviceId: string): Promise<{ runtime: ClimateRuntimeState }> {
    return request(`/climate/${encodeURIComponent(deviceId)}/override`, { method: 'DELETE' });
  },

  setVacation(
    deviceId: string,
    vacation: { active: boolean; until: string | null },
  ): Promise<{ runtime: ClimateRuntimeState }> {
    return request(`/climate/${encodeURIComponent(deviceId)}/vacation`, jsonBody(vacation));
  },
};
