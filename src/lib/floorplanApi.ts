import { adminRequest } from '@/lib/adminApi';
import { refreshSession } from '@/lib/authApi';
import { normalizeGridLayout, normalizePinPosition } from '@/lib/floorplan';
import type {
  Floor,
  FloorLayoutPayload,
  FloorRoom,
  FloorRoomDevice,
  FloorPayload,
} from '@/types/floorplan';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

/**
 * Normalizza la risposta di `GET /api/floors`.
 *
 * Il server è già validato con Zod, ma la planimetria è letta da un tablet:
 * un payload parziale (server più vecchio, riga scritta a mano) non deve mai
 * rompere il canvas. Geometrie e marker vengono riportati dentro i limiti.
 */
export function parseFloors(value: unknown): Floor[] {
  if (!Array.isArray(value)) return [];

  const floors: Floor[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0) continue;
    const floorId = record.id;

    const rooms: FloorRoom[] = Array.isArray(record.rooms)
      ? record.rooms.flatMap((room): FloorRoom[] => {
          if (!room || typeof room !== 'object') return [];
          const row = room as Record<string, unknown>;
          if (typeof row.id !== 'string' || row.id.length === 0) return [];

          const devices: FloorRoomDevice[] = Array.isArray(row.devices)
            ? row.devices.flatMap((device): FloorRoomDevice[] => {
                if (!device || typeof device !== 'object') return [];
                const item = device as Record<string, unknown>;
                if (typeof item.id !== 'string' || typeof item.kind !== 'string') return [];
                return [
                  {
                    id: item.id,
                    name: typeof item.name === 'string' ? item.name : item.id,
                    kind: item.kind as FloorRoomDevice['kind'],
                    roomPinPosition: normalizePinPosition(item.roomPinPosition),
                  },
                ];
              })
            : [];

          return [
            {
              id: row.id,
              label: typeof row.label === 'string' ? row.label : row.id,
              shortLabel:
                typeof row.shortLabel === 'string'
                  ? row.shortLabel
                  : typeof row.label === 'string'
                    ? row.label
                    : row.id,
              icon: typeof row.icon === 'string' ? row.icon : 'home',
              floorId: typeof row.floorId === 'string' ? row.floorId : floorId,
              gridLayout: normalizeGridLayout(row.gridLayout),
              devices,
            },
          ];
        })
      : [];

    floors.push({
      id: floorId,
      name: typeof record.name === 'string' ? record.name : floorId,
      levelOrder:
        typeof record.levelOrder === 'number' && Number.isFinite(record.levelOrder)
          ? record.levelOrder
          : 0,
      icon: typeof record.icon === 'string' ? record.icon : 'Layers',
      rooms,
    });
  }

  return floors.sort((a, b) => a.levelOrder - b.levelOrder || a.name.localeCompare(b.name));
}

async function requestFloors(): Promise<Response> {
  return fetch(`${API_BASE}/floors`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
}

/** Struttura della planimetria: piani, stanze e marker. */
export async function fetchFloors(): Promise<Floor[]> {
  let response = await requestFloors();
  if (response.status === 401 && (await refreshSession())) {
    response = await requestFloors();
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('domus:auth-expired'));
    }
    throw new Error(
      response.status === 401
        ? 'Sessione scaduta: accedi di nuovo.'
        : `Planimetria non disponibile (${response.status})`,
    );
  }

  const payload = (await response.json()) as { floors?: unknown };
  return parseFloors(payload.floors);
}

/**
 * Mutazioni della planimetria (solo admin, il ruolo è riverificato dal server).
 * Il salvataggio del layout è bulk: o passa tutto o non viene scritto nulla.
 */
export const floorplanApi = {
  async createFloor(payload: FloorPayload): Promise<Floor> {
    const response = await adminRequest<{ floor: Floor }>('/floors', 'POST', payload);
    return response.floor;
  },

  async updateFloor(id: string, payload: FloorPayload): Promise<Floor> {
    const response = await adminRequest<{ floor: Floor }>(
      `/floors/${encodeURIComponent(id)}`,
      'PATCH',
      payload,
    );
    return response.floor;
  },

  deleteFloor(id: string): Promise<void> {
    return adminRequest<void>(`/floors/${encodeURIComponent(id)}`, 'DELETE');
  },

  async saveLayout(id: string, payload: FloorLayoutPayload): Promise<Floor> {
    const response = await adminRequest<{ floor: Floor }>(
      `/floors/${encodeURIComponent(id)}/layout`,
      'PUT',
      payload,
    );
    return response.floor;
  },
};

