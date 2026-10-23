import { refreshSession } from '@/lib/authApi';
import type { RoomConfig } from '@/lib/rooms';
import type { Device, Scenario } from '@/types/device';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

/** Payload di `GET /api/topology`: unica fonte della casa, nessun file .config. */
export interface Topology {
  rooms: RoomConfig[];
  devices: Device[];
  scenarios: Scenario[];
}

async function requestTopology(): Promise<Response> {
  return fetch(`${API_BASE}/topology`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
}

/**
 * Carica la topologia dopo il login. Se l'access token è scaduto si tenta una
 * sola rotazione del refresh, come per le API auth; senza sessione il server
 * risponde 401 e la UI resta sul lock screen.
 */
export async function fetchTopology(): Promise<Topology> {
  let response = await requestTopology();
  if (response.status === 401 && (await refreshSession())) {
    response = await requestTopology();
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      // Anche il refresh è fallito: AuthGate deve tornare al lock screen.
      window.dispatchEvent(new CustomEvent('domus:auth-expired'));
    }
    throw new Error(
      response.status === 401
        ? 'Sessione scaduta: accedi di nuovo.'
        : `Topologia non disponibile (${response.status})`,
    );
  }

  const data = (await response.json()) as Partial<Topology> | null;
  if (
    !data ||
    !Array.isArray(data.rooms) ||
    !Array.isArray(data.devices) ||
    !Array.isArray(data.scenarios)
  ) {
    throw new Error('Risposta topologia non valida');
  }

  return { rooms: data.rooms, devices: data.devices, scenarios: data.scenarios };
}
