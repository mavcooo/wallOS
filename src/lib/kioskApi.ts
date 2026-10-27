import i18n from '@/i18n';
import { ApiError, refreshSession } from '@/lib/authApi';
import type { KioskDisplay, KioskDisplayPatch } from '@/types/kiosk';

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
  return (await response.json()) as T;
}

/**
 * Kiosk Profiles: la configurazione vive in PostgreSQL, non nel localStorage.
 *
 * - `get` è l'idratazione all'avvio: se il display non esiste ancora, il server
 *   lo registra con i default (nessun 404 al primo boot, nemmeno in incognito);
 * - `update` manda solo i campi cambiati e il server pubblica contestualmente
 *   la notifica MQTT che il pannello applica senza reload.
 */
export const kioskApi = {
  get(id: string): Promise<{ display: KioskDisplay }> {
    return request(`/kiosk/${encodeURIComponent(id)}`);
  },

  update(id: string, patch: KioskDisplayPatch): Promise<{ display: KioskDisplay }> {
    return request(`/kiosk/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  /** Elenco per la scheda Display dell'amministrazione. */
  list(): Promise<{ displays: KioskDisplay[] }> {
    return request('/kiosk');
  },
};
