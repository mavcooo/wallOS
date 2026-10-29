/**
 * Stato di sicurezza della casa: query e mutazioni su PostgreSQL.
 *
 * Tutto ciò che riguarda armamento, zone e registro eventi passa da qui, così
 * il worker MQTT (`alarmManager.ts`), le rotte REST (`routes/security.ts`) e i
 * test usano le stesse istruzioni SQL e le stesse regole di policy.
 *
 * Principi:
 * - l'evento è **append-only**: acknowledgment e risoluzione aggiungono un
 *   timbro, non cancellano la riga. Lo storico resta ricostruibile anche dopo
 *   anni, che è il requisito di un audit trail di sicurezza;
 * - un solo evento aperto per sensore+tipo, garantito da un indice unico
 *   parziale: messaggi retained all'avvio, raffiche di riconnessione e due
 *   processi in rolling update non duplicano l'allarme;
 * - l'aggregato singleton `security_system_state` viene solo aggiornato, mai
 *   reinserito: due richieste concorrenti non possono creare due stati.
 */

import type { Database } from '../db.js';

/** Stato dell'impianto. `TRIGGERED` significa "allarme in corso". */
export type SecurityStatus = 'DISARMED' | 'ARMED_HOME' | 'ARMED_AWAY' | 'TRIGGERED';

/** Modalità richiedibili dal client: non si "arma" in `TRIGGERED`/`DISARMED`. */
export type SecurityArmMode = 'ARMED_HOME' | 'ARMED_AWAY';

/**
 * Natura della zona:
 * - `emergency`: sensori 24H (fumo, allagamento, gas, CO), sempre attivi;
 * - `perimeter`: contatti su porte/finestre, tipicamente solo in ARMED_AWAY;
 * - `interior`: volumetrici interni, attivi anche in ARMED_HOME.
 */
export type SecurityZoneKind = 'perimeter' | 'interior' | 'emergency';

/** Tipi di evento riconosciuti dal worker. */
export type SecurityEventType =
  | 'smoke'
  | 'flood'
  | 'gas'
  | 'co'
  | 'motion'
  | 'contact'
  | 'tamper'
  | 'intrusion';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export const SECURITY_STATUSES: readonly SecurityStatus[] = [
  'DISARMED',
  'ARMED_HOME',
  'ARMED_AWAY',
  'TRIGGERED',
];

export const SECURITY_EVENT_TYPES: readonly SecurityEventType[] = [
  'smoke',
  'flood',
  'gas',
  'co',
  'motion',
  'contact',
  'tamper',
  'intrusion',
];

export const SECURITY_ARM_MODES: readonly SecurityArmMode[] = ['ARMED_HOME', 'ARMED_AWAY'];

/**
 * Eventi che scattano **sempre**, indipendentemente dall'armamento: un
 * principio d'incendio o un allagamento non aspettano che qualcuno inserisca
 * l'antifurto. La zona `emergency` è comunque sempre armata: questa lista copre
 * il caso di un sensore rimappato a mano in un'altra zona.
 */
const LIFE_SAFETY_EVENTS: ReadonlySet<SecurityEventType> = new Set<SecurityEventType>([
  'smoke',
  'flood',
  'gas',
  'co',
]);

export function isLifeSafetyEvent(eventType: string): boolean {
  return LIFE_SAFETY_EVENTS.has(eventType as SecurityEventType);
}

/**
 * La zona è attiva nella modalità richiesta **e** l'impianto è in quella
 * modalità (o già in allarme: in `TRIGGERED` ogni rilevazione va registrata,
 * altrimenti il secondo sensore di una rapina andrebbe perso).
 */
export function zoneArmed(
  zone: Pick<ZonePolicy, 'kind' | 'armHome' | 'armAway'>,
  status: SecurityStatus,
): boolean {
  if (zone.kind === 'emergency') return true;
  if (status === 'ARMED_HOME') return zone.armHome;
  if (status === 'ARMED_AWAY') return zone.armAway;
  if (status === 'TRIGGERED') return true;
  return false;
}

/** Sottoinsieme di `security_zones` usato dalla policy. */
export interface ZonePolicy {
  kind: SecurityZoneKind;
  armHome: boolean;
  armAway: boolean;
}

export interface SecurityStateRow {
  id: string;
  status: SecurityStatus;
  armedBy: string | null;
  armedAt: string | null;
  disarmedBy: string | null;
  disarmedAt: string | null;
  updatedAt: string;
}

export interface SecurityAttemptRow {
  id: string | number;
  status: string;
  armed_by: string | null;
  armed_at: Date | string | null;
  disarmed_by: string | null;
  disarmed_at: Date | string | null;
  updated_at: Date | string;
}

/** Evento come lo consuma il client (timestamp ISO, già arricchito di nomi). */
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

export interface SecurityEventDbRow {
  id: string | number;
  device_id: string;
  device_name: string | null;
  room_id: string | null;
  room_name: string | null;
  zone_id: string | null;
  event_type: string;
  severity: string;
  payload: unknown;
  triggered_at: Date | string;
  acknowledged_at: Date | string | null;
  acknowledged_by: string | null;
  resolved_at: Date | string | null;
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

export interface SecurityZoneRecord extends ZonePolicy {
  id: string;
  name: string;
  sensors: SecurityZoneSensor[];
}

export interface SecuritySnapshot {
  state: SecurityStateRow;
  zones: SecurityZoneRecord[];
  activeEvents: SecurityEventRecord[];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asPayload(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function severityOf(value: string): SecuritySeverity {
  return value === 'info' || value === 'warning' || value === 'critical' ? value : 'critical';
}

export function toEventRecord(row: SecurityEventDbRow): SecurityEventRecord {
  return {
    id: String(row.id),
    deviceId: row.device_id,
    deviceName: row.device_name ?? row.device_id,
    roomId: row.room_id ?? '',
    roomName: row.room_name ?? row.room_id ?? '',
    zoneId: row.zone_id,
    eventType: row.event_type,
    severity: severityOf(row.severity),
    payload: asPayload(row.payload),
    triggeredAt: iso(row.triggered_at) ?? new Date(0).toISOString(),
    acknowledgedAt: iso(row.acknowledged_at),
    acknowledgedBy: row.acknowledged_by,
    resolvedAt: iso(row.resolved_at),
    notes: row.notes,
  };
}

const STATE_COLUMNS = `id, status, armed_by, armed_at, disarmed_by, disarmed_at, updated_at`;

function toState(rows: SecurityAttemptRow[]): SecurityStateRow {
  const row = rows[0];
  if (!row) {
    // `schema.sql`/la migrazione inseriscono la riga singleton: questo ramo
    // esiste solo su un database creato a mano senza di essa.
    return {
      id: 'primary',
      status: 'DISARMED',
      armedBy: null,
      armedAt: null,
      disarmedBy: null,
      disarmedAt: null,
      updatedAt: new Date(0).toISOString(),
    };
  }
  const status = SECURITY_STATUSES.includes(row.status as SecurityStatus)
    ? (row.status as SecurityStatus)
    : 'DISARMED';
  return {
    id: String(row.id),
    status,
    armedBy: row.armed_by,
    armedAt: iso(row.armed_at),
    disarmedBy: row.disarmed_by,
    disarmedAt: iso(row.disarmed_at),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/** Lettura dello stato corrente; se la riga manca la crea (idempotente). */
export async function readSecurityState(db: Database): Promise<SecurityStateRow> {
  const result = await db.client.query<SecurityAttemptRow>(
    `SELECT ${STATE_COLUMNS} FROM security_system_state WHERE id = 'primary'`,
  );
  if (result.rows.length > 0) return toState(result.rows);

  await db.client.query(
    `INSERT INTO security_system_state (id) VALUES ('primary') ON CONFLICT (id) DO NOTHING`,
  );
  const created = await db.client.query<SecurityAttemptRow>(
    `SELECT ${STATE_COLUMNS} FROM security_system_state WHERE id = 'primary'`,
  );
  return toState(created.rows);
}

interface ZoneRow {
  id: string;
  name: string;
  kind: string;
  arm_home: boolean;
  arm_away: boolean;
  display_order: number;
}

interface ZoneSensorRow {
  zone_id: string;
  device_id: string;
  event_type: string;
  name: string;
  room_id: string;
  room_name: string | null;
  state_topic: string;
}

function zoneKind(value: string): SecurityZoneKind {
  return value === 'emergency' || value === 'interior' || value === 'perimeter'
    ? value
    : 'interior';
}

/** Zone con i sensori mappati, nell'ordine di visualizzazione. */
export async function readSecurityZones(db: Database): Promise<SecurityZoneRecord[]> {
  const zones = await db.client.query<ZoneRow>(
    `SELECT id, name, kind, arm_home, arm_away, display_order
     FROM security_zones
     ORDER BY display_order, id`,
  );
  const sensors = await db.client.query<ZoneSensorRow>(
    `SELECT m.zone_id, m.device_id, m.event_type, d.name, d.room_id,
            r.name AS room_name, d.state_topic
     FROM security_zone_devices m
     JOIN devices d ON d.id = m.device_id
     LEFT JOIN rooms r ON r.id = d.room_id
     ORDER BY d.display_order, d.id`,
  );

  const byZone = new Map<string, SecurityZoneSensor[]>();
  for (const row of sensors.rows) {
    const list = byZone.get(row.zone_id) ?? [];
    list.push({
      deviceId: row.device_id,
      name: row.name,
      roomId: row.room_id,
      roomName: row.room_name ?? row.room_id,
      eventType: row.event_type,
      stateTopic: row.state_topic,
    });
    byZone.set(row.zone_id, list);
  }

  return zones.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: zoneKind(row.kind),
    armHome: row.arm_home,
    armAway: row.arm_away,
    sensors: byZone.get(row.id) ?? [],
  }));
}

export interface ZonePatch {
  name?: string;
  armHome?: boolean;
  armAway?: boolean;
}

/**
 * Aggiorna la policy di una zona (nome e modalità in cui si arma).
 *
 * La zona `emergency` resta sempre attiva per costruzione (`zoneArmed`), anche
 * se il pannello ne modifica i flag: un sensore fumo non può essere disinserito
 * per errore da una toggle.
 *
 * Restituisce la zona aggiornata, o `null` se l'id non esiste.
 */
export async function updateSecurityZone(
  db: Database,
  id: string,
  patch: ZonePatch,
): Promise<SecurityZoneRecord | null> {
  const result = await db.client.query<{ id: string }>(
    `UPDATE security_zones
     SET name = COALESCE($2, name),
         arm_home = COALESCE($3, arm_home),
         arm_away = COALESCE($4, arm_away)
     WHERE id = $1
     RETURNING id`,
    [id, patch.name ?? null, patch.armHome ?? null, patch.armAway ?? null],
  );
  if (result.rows.length === 0) return null;

  const zones = await readSecurityZones(db);
  return zones.find((zone) => zone.id === id) ?? null;
}

/**
 * Sposta un sensore in un'altra zona, conservando il tipo di evento.
 *
 * La mappatura deve già esistere: è il worker a crearla al primo avvio in base
 * a `metadata.state.type`, quindi questa rotta non inventa un tipo di allarme.
 * `false` = sensore non mappato o zona inesistente (il chiamante risponde 404).
 */
export async function moveSensorToZone(
  db: Database,
  deviceId: string,
  zoneId: string,
): Promise<boolean> {
  const zone = await db.client.query<{ id: string }>(
    `SELECT id FROM security_zones WHERE id = $1`,
    [zoneId],
  );
  if (zone.rows.length === 0) return false;

  const result = await db.client.query<{ device_id: string }>(
    `UPDATE security_zone_devices
     SET zone_id = $2, updated_at = NOW()
     WHERE device_id = $1
     RETURNING device_id`,
    [deviceId, zoneId],
  );
  return result.rows.length > 0;
}

const EVENT_SELECT = `SELECT e.id, e.device_id, d.name AS device_name,
         d.room_id, r.name AS room_name, m.zone_id,
         e.event_type, e.severity, e.payload, e.triggered_at,
         e.acknowledged_at, e.acknowledged_by, e.resolved_at, e.notes
  FROM security_events e
  JOIN devices d ON d.id = e.device_id
  LEFT JOIN rooms r ON r.id = d.room_id
  LEFT JOIN security_zone_devices m ON m.device_id = e.device_id`;

/** Eventi ancora aperti (non risolti), dal più recente. */
export async function readActiveEvents(db: Database): Promise<SecurityEventRecord[]> {
  const result = await db.client.query<SecurityEventDbRow>(
    `${EVENT_SELECT}
     WHERE e.resolved_at IS NULL
     ORDER BY e.triggered_at DESC, e.id DESC`,
  );
  return result.rows.map(toEventRecord);
}

/**
 * Snapshot completo servito da `GET /api/security/state` e pubblicato sugli
 * eventi real-time: stato, zone e allarmi pendenti in una sola risposta, così
 * un tablet che si riaccende non deve fare tre chiamate per mostrare l'overlay.
 */
export async function readSecuritySnapshot(db: Database): Promise<SecuritySnapshot> {
  const [state, zones, activeEvents] = await Promise.all([
    readSecurityState(db),
    readSecurityZones(db),
    readActiveEvents(db),
  ]);
  return { state, zones, activeEvents };
}

export interface ArmInput {
  mode: SecurityArmMode;
  /** UUID del profilo che ha verificato il PIN. */
  userId: string;
}

/** Armamento: aggiorna la riga singleton e azzera i timbri di disinserimento. */
export async function armSystem(db: Database, input: ArmInput): Promise<SecurityStateRow> {
  const result = await db.client.query<SecurityAttemptRow>(
    `UPDATE security_system_state
     SET status = $1, armed_by = $2, armed_at = NOW(),
         disarmed_by = NULL, disarmed_at = NULL, updated_at = NOW()
     WHERE id = 'primary'
     RETURNING ${STATE_COLUMNS}`,
    [input.mode, input.userId],
  );
  return toState(result.rows);
}

/** Disinserimento: conserva chi ha armato e quando, per l'audit. */
export async function disarmSystem(db: Database, userId: string): Promise<SecurityStateRow> {
  const result = await db.client.query<SecurityAttemptRow>(
    `UPDATE security_system_state
     SET status = 'DISARMED', disarmed_by = $1, disarmed_at = NOW(), updated_at = NOW()
     WHERE id = 'primary'
     RETURNING ${STATE_COLUMNS}`,
    [userId],
  );
  return toState(result.rows);
}

/** Porta l'impianto in `TRIGGERED` senza toccare i timbri di armamento. */
export async function triggerSystem(db: Database): Promise<SecurityStateRow> {
  const result = await db.client.query<SecurityAttemptRow>(
    `UPDATE security_system_state
     SET status = 'TRIGGERED', updated_at = NOW()
     WHERE id = 'primary' AND status <> 'TRIGGERED'
     RETURNING ${STATE_COLUMNS}`,
  );
  if (result.rows.length > 0) return toState(result.rows);
  // Già in allarme: `RETURNING` non produce righe, lo stato va riletto.
  return readSecurityState(db);
}

export interface NewSecurityEvent {
  deviceId: string;
  eventType: string;
  severity: SecuritySeverity;
  payload: Record<string, unknown> | null;
  /** `null` = `NOW()` (produzione); i test possono fissarlo. */
  triggeredAt?: Date | null;
  /** Audit di una rilevazione a impianto disinserito: riga già chiusa. */
  resolvedAt?: Date | null;
  notes?: string | null;
}

/**
 * Inserisce un evento. In modalità allarme (nessun `resolvedAt`) l'indice
 * parziale unico fa da arbitro: se esiste già un evento aperto per lo stesso
 * sensore e tipo, `ON CONFLICT DO NOTHING` non scrive nulla e la funzione
 * restituisce `null`. È questo che rende sicura la concorrenza fra due messaggi
 * identici (o fra due worker).
 */
export async function insertSecurityEvent(
  db: Database,
  event: NewSecurityEvent,
): Promise<SecurityEventRecord | null> {
  const resolvedAt = event.resolvedAt ?? null;
  const result = await db.client.query<SecurityEventDbRow>(
    `WITH inserted AS (
       INSERT INTO security_events
         (device_id, event_type, severity, payload, triggered_at, resolved_at, notes)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, NOW()),
               $6::timestamptz, $7)
       ON CONFLICT (device_id, event_type) WHERE resolved_at IS NULL DO NOTHING
       RETURNING *
     )
     SELECT i.id, i.device_id, d.name AS device_name, d.room_id,
            r.name AS room_name, m.zone_id,
            i.event_type, i.severity, i.payload, i.triggered_at,
            i.acknowledged_at, i.acknowledged_by, i.resolved_at, i.notes
     FROM inserted i
     JOIN devices d ON d.id = i.device_id
     LEFT JOIN rooms r ON r.id = d.room_id
     LEFT JOIN security_zone_devices m ON m.device_id = i.device_id`,
    [
      event.deviceId,
      event.eventType,
      event.severity,
      event.payload === null ? null : JSON.stringify(event.payload),
      event.triggeredAt ?? null,
      resolvedAt,
      event.notes ?? null,
    ],
  );
  const row = result.rows[0];
  return row ? toEventRecord(row) : null;
}

export type EventMutationStatus = 'updated' | 'not_found' | 'already_resolved' | 'already_acknowledged';

export interface EventMutationResult {
  status: EventMutationStatus;
  event: SecurityEventRecord | null;
}

async function readEvent(db: Database, id: string): Promise<SecurityEventRecord | null> {
  const result = await db.client.query<SecurityEventDbRow>(
    `${EVENT_SELECT} WHERE e.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toEventRecord(row) : null;
}

/**
 * Acknowledgment formale: timbra `acknowledged_at`/`acknowledged_by` **senza**
 * chiudere l'evento. È la differenza che il pannello deve rispettare fra
 * "tacita la sirena" (solo audio locale) e "ho preso in carico l'allarme".
 */
export async function acknowledgeSecurityEvent(
  db: Database,
  id: string,
  userId: string,
): Promise<EventMutationResult> {
  const result = await db.client.query<{ id: string }>(
    `UPDATE security_events
     SET acknowledged_at = NOW(), acknowledged_by = $2
     WHERE id = $1 AND resolved_at IS NULL AND acknowledged_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if (result.rows.length > 0) return { status: 'updated', event: await readEvent(db, id) };

  const existing = await readEvent(db, id);
  if (!existing) return { status: 'not_found', event: null };
  if (existing.resolvedAt !== null) return { status: 'already_resolved', event: existing };
  return { status: 'already_acknowledged', event: existing };
}

/**
 * Rientro dell'evento: timbra `resolved_at` e, quando non resta nessun allarme
 * aperto, riporta l'impianto in `DISARMED` (lo stato sicuro di default: nessuno
 * può restare "in allarme" per un evento già rientrato).
 */
export async function resolveSecurityEvent(
  db: Database,
  id: string,
  userId: string,
  notes: string | null = null,
): Promise<EventMutationResult> {
  const result = await db.client.query<{ id: string }>(
    `UPDATE security_events
     SET resolved_at = NOW(),
         acknowledged_at = COALESCE(acknowledged_at, NOW()),
         acknowledged_by = COALESCE(acknowledged_by, $2),
         notes = COALESCE($3, notes)
     WHERE id = $1 AND resolved_at IS NULL
     RETURNING id`,
    [id, userId, notes],
  );

  if (result.rows.length === 0) {
    const existing = await readEvent(db, id);
    return existing
      ? { status: 'already_resolved', event: existing }
      : { status: 'not_found', event: null };
  }

  const remaining = await db.client.query<{ count: string | number }>(
    `SELECT COUNT(*)::int AS count FROM security_events
     WHERE resolved_at IS NULL AND severity = 'critical'`,
  );
  if (Number(remaining.rows[0]?.count ?? 0) === 0) {
    await db.client.query(
      `UPDATE security_system_state
       SET status = 'DISARMED', disarmed_by = $1, disarmed_at = NOW(), updated_at = NOW()
       WHERE id = 'primary' AND status = 'TRIGGERED'`,
      [userId],
    );
  }

  return { status: 'updated', event: await readEvent(db, id) };
}

export interface HistoryFilter {
  /** Estremi inclusi, ISO 8601. */
  from?: Date | null;
  to?: Date | null;
  limit: number;
  /** Keyset `(triggered_at, id)` della pagina precedente. */
  cursor?: { triggeredAt: Date; id: string } | null;
  severity?: SecuritySeverity | null;
}

export interface HistoryPage {
  events: SecurityEventRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function encodeHistoryCursor(triggeredAt: Date, id: string): string {
  return Buffer.from(`${triggeredAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** `null` per un cursore malformato: il chiamante risponde 400. */
export function decodeHistoryCursor(value: string): { triggeredAt: Date; id: string } | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const separator = text.indexOf('|');
    if (separator <= 0) return null;
    const timestamp = Date.parse(text.slice(0, separator));
    const id = text.slice(separator + 1);
    if (!Number.isFinite(timestamp) || !/^\d+$/.test(id)) return null;
    return { triggeredAt: new Date(timestamp), id };
  } catch {
    return null;
  }
}

/**
 * Storico paginato keyset su `(triggered_at, id)` decrescente: stabile anche
 * con decine di eventi nello stesso secondo, e senza `OFFSET` che degrada con
 * la profondità.
 */
export async function readSecurityHistory(
  db: Database,
  filter: HistoryFilter,
): Promise<HistoryPage> {
  const params: unknown[] = [filter.from ?? null, filter.to ?? null];
  const conditions = [
    `($2::timestamptz IS NULL OR e.triggered_at <= $2::timestamptz)`,
    `($1::timestamptz IS NULL OR e.triggered_at >= $1::timestamptz)`,
  ];

  if (filter.severity) {
    params.push(filter.severity);
    conditions.push(`e.severity = $${params.length}`);
  }
  if (filter.cursor) {
    params.push(filter.cursor.triggeredAt, filter.cursor.id);
    conditions.push(
      `(e.triggered_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`,
    );
  }
  // Una riga in più solo per sapere se esiste la pagina successiva.
  params.push(filter.limit + 1);

  const result = await db.client.query<SecurityEventDbRow>(
    `${EVENT_SELECT}
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.triggered_at DESC, e.id DESC
     LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > filter.limit;
  const page = hasMore ? result.rows.slice(0, filter.limit) : result.rows;
  const last = page[page.length - 1];

  return {
    events: page.map(toEventRecord),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeHistoryCursor(
            last.triggered_at instanceof Date
              ? last.triggered_at
              : new Date(last.triggered_at),
            String(last.id),
          )
        : null,
  };
}

/** Sensore aperto (contatto magnetico o manomissione) noto al worker. */
export interface OpenSensor {
  deviceId: string;
  name: string;
  roomName: string;
  eventType: string;
  since: string;
}

/** Motivo per cui l'armamento viene rifiutato (`409 ZONE_NOT_READY`). */
export interface ArmBlocker {
  kind: 'active_alarm' | 'open_sensor';
  deviceId: string;
  label: string;
}
