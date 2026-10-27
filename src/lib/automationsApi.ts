import i18n from '@/i18n';
import { ApiError, refreshSession } from '@/lib/authApi';
import type {
  Automation,
  AutomationDraft,
  AutomationLogEntry,
  AutomationTestExecution,
  DeviceAutomationActivity,
} from '@/types/automations';

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

/** Richiesta autenticata: un solo tentativo di rotazione del refresh sul 401. */
async function request<T>(path: string, init: RequestInit = { method: 'GET' }): Promise<T> {
  let response = await send(path, init);
  if (response.status === 401 && (await refreshSession())) {
    response = await send(path, init);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonBody(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Automazioni: il motore che valuta i trigger e pubblica i comandi vive sul
 * server (`server/services/automationEngine.ts`). Il pannello elenca le regole,
 * le attiva/disattiva, ne forza il test e ne consulta lo storico.
 */
export const automationsApi = {
  list(): Promise<{ automations: Automation[] }> {
    return request('/automations');
  },

  create(draft: AutomationDraft): Promise<{ automation: Automation }> {
    return request('/automations', jsonBody(draft));
  },

  update(id: string, draft: AutomationDraft): Promise<{ automation: Automation }> {
    return request(`/automations/${encodeURIComponent(id)}`, jsonBody(draft, 'PUT'));
  },

  /** Interruttore rapido: `isActive` assente inverte lo stato corrente. */
  toggle(id: string, isActive?: boolean): Promise<{ automation: Automation }> {
    return request(
      `/automations/${encodeURIComponent(id)}/toggle`,
      jsonBody(isActive === undefined ? {} : { isActive }, 'PATCH'),
    );
  },

  /** Esecuzione forzata che ignora le condizioni della regola. */
  test(id: string): Promise<{ execution: AutomationTestExecution }> {
    return request(`/automations/${encodeURIComponent(id)}/test`, jsonBody({}));
  },

  logs(id: string, limit = 10): Promise<{ automationId: string; logs: AutomationLogEntry[] }> {
    return request(`/automations/${encodeURIComponent(id)}/logs?limit=${limit}`);
  },

  /** Ultimi comandi inviati per device: alimenta il badge sulle card. */
  activity(): Promise<{ activity: DeviceAutomationActivity[] }> {
    return request('/automations/activity');
  },

  remove(id: string): Promise<void> {
    return request(`/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
