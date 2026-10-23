import { ApiError, refreshSession } from '@/lib/authApi';
import type { RoomConfig } from '@/lib/rooms';
import type { AdapterId, Device, DeviceKind, Scenario, ScenarioStep } from '@/types/device';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

export interface RoomPayload {
  id?: string;
  name: string;
  shortLabel?: string | null;
  icon?: string;
  displayOrder?: number;
}

export interface DevicePayload {
  id?: string;
  roomId: string;
  name: string;
  type: DeviceKind;
  adapter: AdapterId;
  model?: string | null;
  stateTopic: string;
  commandTopic?: string | null;
  availabilityTopic?: string | null;
  favorite?: boolean;
  protected?: boolean;
  displayOrder?: number;
  /** Solo custom-json: campo normalizzato → percorso nel payload. */
  fieldMap?: Record<string, string> | null;
}

export interface ScenarioPayload {
  id?: string;
  label: string;
  description?: string;
  icon?: string;
  protected?: boolean;
  actions: ScenarioStep[];
  displayOrder?: number;
}

async function toApiError(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof data?.error === 'string' ? data.error : 'HTTP_ERROR';
  const message = typeof data?.message === 'string' ? data.message : `Errore ${response.status}`;
  return new ApiError(response.status, code, message);
}

async function request<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const send = () =>
    fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let response = await send();
  if (response.status === 401 && (await refreshSession())) response = await send();
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * CRUD della topologia: solo il ruolo admin è autorizzato dal server.
 * Ogni mutazione restituisce l'entità ricostruita come la legge `/api/topology`.
 */
export const adminApi = {
  createRoom(payload: RoomPayload): Promise<{ room: RoomConfig }> {
    return request('/rooms', 'POST', payload);
  },

  updateRoom(id: string, payload: RoomPayload): Promise<{ room: RoomConfig }> {
    return request(`/rooms/${encodeURIComponent(id)}`, 'PATCH', payload);
  },

  deleteRoom(id: string): Promise<void> {
    return request(`/rooms/${encodeURIComponent(id)}`, 'DELETE');
  },

  createDevice(payload: DevicePayload): Promise<{ device: Device }> {
    return request('/devices', 'POST', payload);
  },

  updateDevice(id: string, payload: DevicePayload): Promise<{ device: Device }> {
    return request(`/devices/${encodeURIComponent(id)}`, 'PATCH', payload);
  },

  deleteDevice(id: string): Promise<void> {
    return request(`/devices/${encodeURIComponent(id)}`, 'DELETE');
  },

  createScenario(payload: ScenarioPayload): Promise<{ scenario: Scenario }> {
    return request('/scenarios', 'POST', payload);
  },

  updateScenario(id: string, payload: ScenarioPayload): Promise<{ scenario: Scenario }> {
    return request(`/scenarios/${encodeURIComponent(id)}`, 'PATCH', payload);
  },

  deleteScenario(id: string): Promise<void> {
    return request(`/scenarios/${encodeURIComponent(id)}`, 'DELETE');
  },
};
