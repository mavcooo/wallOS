import { ApiError, refreshSession } from '@/lib/authApi';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

/** Stato dell'impianto, identico all'enum di `security_system_state`. */
export type SecurityStatus = 'DISARMED' | 'ARMED_HOME' | 'ARMED_AWAY' | 'TRIGGERED';

/** Modalità richiedibili: `TRIGGERED` è solo un effetto di un allarme. */
export type SecurityArmMode = 'ARMED_HOME' | 'ARMED_AWAY';

export type SecurityZoneKind = 'perimeter' | 'interior' | 'emergency';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

/** Evento di allarme persistito: `resolvedAt === null` = ancora aperto. */
export interface SecurityEventRecord {
  id: string;
  deviceId: string;
  deviceName: string;
  roomId: string;
  roomName: string;
  zoneId: string | null;
  eventType: string;
  severity: SecuritySeverity;
  payload: Record<string, unknown> | null;
  triggeredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  notes: string | null;
}

export interface SecurityZoneSensor {
  deviceId: string;
  name: string;
  roomId: string;
  roomName: string;
  eventType: string;
  stateTopic: string;
}

export interface SecurityZone {
  id: string;
  name: string;
  kind: SecurityZoneKind;
  armHome: boolean;
  armAway: boolean;
  sensors: SecurityZoneSensor[];
}

export interface OpenSensor {
  deviceId: string;
  name: string;
  roomName: string;
  eventType: string;
  since: string;
}

export interface SecuritySystemState {
  status: SecurityStatus;
  armedBy: string | null;
  armedAt: string | null;
  disarmedBy: string | null;
  disarmedAt: string | null;
  updatedAt: string;
}

export interface SecuritySnapshot {
  state: SecuritySystemState;
  zones: SecurityZone[];
  activeEvents: SecurityEventRecord[];
  openSensors: OpenSensor[];
}

export interface SecurityHistoryPage {
  events: SecurityEventRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isoText(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

function isStatus(value: unknown): value is SecurityStatus {
  return (
    value === 'DISARMED' || value === 'ARMED_HOME' || value === 'ARMED_AWAY' || value === 'TRIGGERED'
  );
}

function isSeverity(value: unknown): value is SecuritySeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

function isZoneKind(value: unknown): value is SecurityZoneKind {
  return value === 'perimeter' || value === 'interior' || value === 'emergency';
}

/**
 * Normalizza un evento. Una riga malformata (server più vecchio, risposta
 * parziale) viene scartata invece di rompere l'overlay: durante un allarme il
 * pannello non può mostrare una schermata bianca.
 */
export function parseSecurityEvent(value: unknown): SecurityEventRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;

  const id =
    typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : null;
  const deviceId = text(row.deviceId);
  const eventType = text(row.eventType);
  const triggeredAt = isoText(row.triggeredAt);
  if (!id || !deviceId || !eventType || !triggeredAt) return null;

  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;

  return {
    id,
    deviceId,
    deviceName: text(row.deviceName) ?? deviceId,
    roomId: text(row.roomId) ?? '',
    roomName: text(row.roomName) ?? '',
    zoneId: text(row.zoneId),
    eventType,
    severity: isSeverity(row.severity) ? row.severity : 'critical',
    payload,
    triggeredAt,
    acknowledgedAt: isoText(row.acknowledgedAt),
    acknowledgedBy: text(row.acknowledgedBy),
    resolvedAt: isoText(row.resolvedAt),
    notes: text(row.notes),
  };
}

function parseZones(value: unknown): SecurityZone[] {
  if (!Array.isArray(value)) return [];
  const zones: SecurityZone[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = text(row.id);
    if (!id) continue;
    const sensors: SecurityZoneSensor[] = Array.isArray(row.sensors)
      ? row.sensors.flatMap((sensor) => {
          if (!sensor || typeof sensor !== 'object') return [];
          const item = sensor as Record<string, unknown>;
          const deviceId = text(item.deviceId);
          if (!deviceId) return [];
          return [
            {
              deviceId,
              name: text(item.name) ?? deviceId,
              roomId: text(item.roomId) ?? '',
              roomName: text(item.roomName) ?? '',
              eventType: text(item.eventType) ?? 'intrusion',
              stateTopic: text(item.stateTopic) ?? '',
            },
          ];
        })
      : [];

    zones.push({
      id,
      name: text(row.name) ?? id,
      kind: isZoneKind(row.kind) ? row.kind : 'interior',
      armHome: row.armHome === true,
      armAway: row.armAway !== false,
      sensors,
    });
  }
  return zones;
}

function parseOpenSensors(value: unknown): OpenSensor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const deviceId = text(row.deviceId);
    if (!deviceId) return [];
    return [
      {
        deviceId,
        name: text(row.name) ?? deviceId,
        roomName: text(row.roomName) ?? '',
        eventType: text(row.eventType) ?? 'contact',
        since: isoText(row.since) ?? new Date(0).toISOString(),
      },
    ];
  });
}

/** Snapshot tollerante: gli eventi aperti sono la parte che non può mancare. */
export function parseSecuritySnapshot(value: unknown): SecuritySnapshot {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const state = row.state && typeof row.state === 'object' ? (row.state as Record<string, unknown>) : {};

  return {
    state: {
      status: isStatus(state.status) ? state.status : 'DISARMED',
      armedBy: text(state.armedBy),
      armedAt: isoText(state.armedAt),
      disarmedBy: text(state.disarmedBy),
      disarmedAt: isoText(state.disarmedAt),
      updatedAt: isoText(state.updatedAt) ?? new Date(0).toISOString(),
    },
    zones: parseZones(row.zones),
    activeEvents: Array.isArray(row.activeEvents)
      ? row.activeEvents.flatMap((entry) => {
          const event = parseSecurityEvent(entry);
          return event ? [event] : [];
        })
      : [],
    openSensors: parseOpenSensors(row.openSensors),
  };
}

async function toApiError(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return new ApiError(
    response.status,
    typeof data?.error === 'string' ? data.error : 'HTTP_ERROR',
    typeof data?.message === 'string' ? data.message : `Errore sicurezza (${response.status})`,
  );
}

function send(path: string, init: RequestInit = { method: 'GET' }): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
  });
}

/** Richiesta autenticata: un solo tentativo di refresh sul 401. */
async function request<T>(path: string, init: RequestInit = { method: 'GET' }): Promise<T> {
  let response = await send(path, init);
  if (response.status === 401 && (await refreshSession())) {
    response = await send(path, init);
  }
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

function post(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Contratto con `server/routes/security.ts`.
 *
 * - `state` è l'idratazione: stato + zone + allarmi ancora aperti. È anche la
 *   sorgente dell'overlay dopo un riavvio del tablet;
 * - `arm`/`disarm` richiedono il PIN (o una sessione già elevata da
 *   `/api/auth/verify-pin`): il pannello non decide mai da solo se può armare;
 * - `acknowledge` è il riconoscimento formale e **non** chiude l'evento;
 * - `resolve` marca il rientro e l'evento resta nello storico.
 */
export const securityApi = {
  state(signal?: AbortSignal): Promise<SecuritySnapshot> {
    return request<unknown>('/security/state', { method: 'GET', ...(signal ? { signal } : {}) }).then(
      parseSecuritySnapshot,
    );
  },

  arm(mode: SecurityArmMode, pin?: string): Promise<SecuritySnapshot> {
    return request<unknown>('/security/arm', post({ mode, ...(pin ? { pin } : {}) })).then(
      parseSecuritySnapshot,
    );
  },

  disarm(pin?: string): Promise<SecuritySnapshot> {
    return request<unknown>('/security/disarm', post(pin ? { pin } : {})).then(
      parseSecuritySnapshot,
    );
  },

  acknowledge(id: string, pin?: string): Promise<SecurityEventRecord | null> {
    return request<{ event?: unknown }>(
      `/security/events/${encodeURIComponent(id)}/ack`,
      post(pin ? { pin } : {}),
    ).then((body) => parseSecurityEvent(body.event));
  },

  resolve(id: string, notes?: string, pin?: string): Promise<SecurityEventRecord | null> {
    return request<{ event?: unknown }>(
      `/security/events/${encodeURIComponent(id)}/resolve`,
      post({ ...(pin ? { pin } : {}), ...(notes ? { notes } : {}) }),
    ).then((body) => parseSecurityEvent(body.event));
  },

  async history(params: {
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
    severity?: SecuritySeverity;
    signal?: AbortSignal;
  } = {}): Promise<SecurityHistoryPage> {
    const search = new URLSearchParams();
    if (params.from) search.set('from', params.from);
    if (params.to) search.set('to', params.to);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.severity) search.set('severity', params.severity);
    const query = search.toString();

    const body = await request<{ events?: unknown; hasMore?: unknown; nextCursor?: unknown }>(
      `/security/history${query ? `?${query}` : ''}`,
      { method: 'GET', ...(params.signal ? { signal: params.signal } : {}) },
    );

    return {
      events: Array.isArray(body.events)
        ? body.events.flatMap((entry) => {
            const event = parseSecurityEvent(entry);
            return event ? [event] : [];
          })
        : [],
      hasMore: body.hasMore === true,
      nextCursor: text(body.nextCursor),
    };
  },
};
