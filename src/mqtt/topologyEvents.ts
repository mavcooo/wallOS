/**
 * Evento di topologia pubblicato dal server su `wallos/system/topology_changed`
 * **dopo** il commit di una mutazione su PostgreSQL (create/update/delete/
 * reorder di stanze, dispositivi e scenari).
 *
 * Lato server il pendant è `server/services/topologyEvents.ts`: i due payload
 * devono restare allineati (stesso `.env`, stesso base topic).
 */

export const TOPOLOGY_CHANGED_TOPIC = 'wallos/system/topology_changed';

export type TopologyEntity = 'room' | 'device' | 'scenario';

export type TopologyChangeKind = 'created' | 'updated' | 'deleted' | 'reordered';

export interface TopologyChangedEvent {
  /** Es. `device_created`: non determina il comportamento, solo il log. */
  event: string;
  entity: TopologyEntity;
  id: string;
  timestamp: number;
  /** Pannello che ha originato la mutazione: quel client salta il refetch. */
  sourceClientId?: string;
}

const ENTITIES: readonly TopologyEntity[] = ['room', 'device', 'scenario'];

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Parsing del payload: un messaggio malformato viene ignorato (nessun
 * refetch spurio), come per i payload di availability.
 */
export function parseTopologyChanged(payload: string): TopologyChangedEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const record = data as Record<string, unknown>;
  const event = optionalString(record.event);
  const entity = optionalString(record.entity) as TopologyEntity | undefined;
  const id = optionalString(record.id);
  if (!event || !entity || !id || !ENTITIES.includes(entity)) return null;

  const timestamp =
    typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();
  const sourceClientId = optionalString(record.sourceClientId);

  return {
    event,
    entity,
    id,
    timestamp,
    ...(sourceClientId ? { sourceClientId } : {}),
  };
}

type Listener = (event: TopologyChangedEvent) => void;

/**
 * Bus in-memory tra `useMqtt` (unico possessore della socket) e
 * `useTopologySync` (unico possessore del QueryClient): il bus tiene il hook
 * indipendente dal ciclo di vita della connessione e lo rende testabile da
 * solo.
 */
const listeners = new Set<Listener>();

export function onTopologyChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitTopologyChanged(event: TopologyChangedEvent): void {
  for (const listener of listeners) listener(event);
}
