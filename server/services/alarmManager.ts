/**
 * Worker di sicurezza: rileva gli allarmi dal broker anche con tutti i browser
 * chiusi.
 *
 * Prima di questo modulo la rilevazione viveva in `src/hooks/useMqtt.ts`: se il
 * tablet era spento, la WebSocket caduta o la pagina ricaricata, un sensore fumo
 * che scattava non produceva nulla. Il worker è un processo Node con la propria
 * connessione MQTT (listener TCP, non WebSocket) che:
 *
 * 1. legge da `devices` i sensori con un profilo di sicurezza (`metadata.state.type`),
 *    li mappa su una zona (`security_zone_devices`) e si sottoscrive al loro
 *    topic di stato. La mappatura mancante viene creata al primo avvio:
 *    fumo/allagamento/gas/CO → zona `emergency`, contatti → `perimeter`,
 *    volumetrici → `interior`. Un sensore di temperatura o CO₂ non entra mai
 *    nel sistema di allarme;
 * 2. normalizza i payload eterogenei dei firmware (`smoke`, `water_leak`,
 *    `tamper`, `contact`, `state: "ALARM"`, stringhe e numeri) e riconosce la
 *    transizione allarme ↔ quiete;
 * 3. applica la policy di armamento: i sensori 24H scattano **sempre**, gli
 *    altri solo se la loro zona è attiva nella modalità corrente. Una
 *    rilevazione a impianto disinserito finisce comunque nel registro come
 *    audit `info` già chiuso, senza suonare;
 * 4. scrive l'evento in `security_events` e porta lo stato su `TRIGGERED`. La
 *    deduplica è nel database (indice unico parziale sugli eventi aperti),
 *    quindi un messaggio retained rielaborato dopo un riavvio del gateway o due
 *    messaggi identici in parallelo non creano due allarmi;
 * 5. notifica il pannello via `SecurityEventBus` (SSE) e pubblica lo stato
 *    retained su `security/alarm_state` per gli altri consumatori MQTT;
 * 6. sopravvive a broker e database irraggiungibili: l'errore viene loggato e
 *    il worker resta in ascolto, senza terminare il processo.
 *
 * Il ciclo di vita (`start()`/`stop()`) lo pilota `server/index.ts`; nei test
 * `buildApp` costruisce l'istanza senza socket e si inietta un `MqttLink` finto.
 */

import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import type { Database } from '../db.js';
import { createMqttLink, type MqttLink } from '../mqttClient.js';
import {
  createSecurityEventBus,
  type SecurityEventBus,
  type SecurityEventKind,
  type SecurityStateEvent,
} from './securityEvents.js';
import {
  insertSecurityEvent,
  isLifeSafetyEvent,
  readSecuritySnapshot,
  readSecurityState,
  triggerSystem,
  zoneArmed,
  type OpenSensor,
  type SecurityEventType,
  type SecuritySnapshot,
  type SecurityZoneKind,
  type ZonePolicy,
} from './securityStore.js';
import type { AuthConfig } from '../types.js';

/** Topic relativo: `<MQTT_BASE_TOPIC>/security/#`. */
export const SECURITY_WILDCARD = 'security/#';
/** Ingresso esterno (allarme panel, script Python, test): JSON validato. */
export const SECURITY_TRIGGER_TOPIC = 'security/trigger';
/** Stato consolidato per i consumatori MQTT (retained). */
export const SECURITY_ALARM_STATE_TOPIC = 'security/alarm_state';

/** Campi che possono dichiarare un allarme, per tipo di sensore. */
const FLAG_KEYS: Record<SecurityEventType, readonly string[]> = {
  smoke: ['smoke', 'smoke_detected', 'smoke_alarm'],
  flood: ['water_leak', 'flood', 'water_detected', 'leak'],
  gas: ['gas', 'gas_detected', 'gas_alarm'],
  co: ['carbon_monoxide', 'co', 'co_detected'],
  motion: ['occupancy', 'motion', 'presence', 'pir'],
  contact: ['contact', 'door', 'window', 'opening'],
  tamper: ['tamper', 'tamper_detected'],
  intrusion: ['intrusion', 'alarm', 'tamper'],
};

const TRUE_VALUES = new Set([
  'true',
  '1',
  'on',
  'open',
  'opened',
  'alarm',
  'alarm_active',
  'detected',
  'triggered',
  'leak',
  'wet',
  'smoke',
]);
const FALSE_VALUES = new Set([
  'false',
  '0',
  'off',
  'closed',
  'clear',
  'idle',
  'ok',
  'normal',
  'dry',
  'none',
]);
const ALARM_STATES = /^(alarm|alarm_active|triggered|detected)$/i;
const QUIET_STATES = /^(clear|idle|ok|normal|disarmed|closed)$/i;

/**
 * Interpreta un singolo valore booleano-like (`true`, `"ON"`, `1`, `"open"`…).
 * `null` quando il valore non è né allarme né quiete: in quel caso il campo
 * viene ignorato invece di produrre un falso positivo.
 */
export function flagValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
  }
  return null;
}

export interface AlarmDetection {
  active: boolean;
  /** Campo che ha deciso: finisce nel payload dell'evento, per diagnostica. */
  field: string;
  /** Payload JSON normalizzato (o `null` per un payload testuale). */
  body: Record<string, unknown> | null;
}

/**
 * Riconosce allarme e quiete nei payload dei sensori. Restituisce `null` per
 * la telemetria normale (batteria, temperatura, linkquality): un messaggio che
 * non parla di sicurezza non deve mai creare un evento.
 */
export function detectSecurityAlarm(
  eventType: SecurityEventType,
  rawPayload: string,
): AlarmDetection | null {
  const text = rawPayload.trim();
  if (text.length === 0) return null;

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  if (!body) {
    const flat = flagValue(text);
    return flat === null ? null : { active: flat, field: 'payload', body: null };
  }

  // Stato esplicito: `{"state": "ALARM"}` è il contratto di molti bridge.
  for (const key of ['state', 'status', 'alarm_state'] as const) {
    const value = body[key];
    if (typeof value !== 'string') continue;
    if (ALARM_STATES.test(value.trim())) return { active: true, field: key, body };
    if (QUIET_STATES.test(value.trim())) return { active: false, field: key, body };
  }

  for (const key of FLAG_KEYS[eventType]) {
    if (!(key in body)) continue;
    const flag = flagValue(body[key]);
    if (flag === null) continue;
    return { active: flag, field: key, body };
  }

  return null;
}

/**
 * Profilo di sicurezza dedotto dal tipo di sensore. `null` = il dispositivo
 * non partecipa agli allarmi (temperatura, umidità, CO₂…).
 */
export function sensorProfile(
  stateType: string | null,
): { eventType: SecurityEventType; zoneId: string } | null {
  const type = (stateType ?? '').trim().toLowerCase();
  switch (type) {
    case 'smoke':
    case 'smoke_detector':
      return { eventType: 'smoke', zoneId: 'emergency' };
    case 'flood':
    case 'water':
    case 'water_leak':
    case 'leak':
      return { eventType: 'flood', zoneId: 'emergency' };
    case 'gas':
    case 'gas_leak':
      return { eventType: 'gas', zoneId: 'emergency' };
    case 'co':
    case 'carbon_monoxide':
      return { eventType: 'co', zoneId: 'emergency' };
    case 'motion':
    case 'pir':
    case 'occupancy':
    case 'presence':
      return { eventType: 'motion', zoneId: 'interior' };
    case 'contact':
    case 'door':
    case 'window':
    case 'garage_door':
    case 'opening':
      return { eventType: 'contact', zoneId: 'perimeter' };
    case 'tamper':
      return { eventType: 'tamper', zoneId: 'perimeter' };
    case 'intrusion':
      return { eventType: 'intrusion', zoneId: 'perimeter' };
    default:
      return null;
  }
}

/** Riga di `devices`+mappatura letta dal worker. */
interface SensorRow {
  id: string;
  name: string;
  room_id: string;
  room_name: string | null;
  state_topic: string;
  state_type: string | null;
  zone_id: string | null;
  event_type: string | null;
  kind: string | null;
  arm_home: boolean | null;
  arm_away: boolean | null;
}

interface ZoneRow {
  id: string;
  kind: string;
  arm_home: boolean;
  arm_away: boolean;
}

/** Sensore monitorato, con la policy della sua zona risolta in memoria. */
export interface SecuritySensor extends ZonePolicy {
  deviceId: string;
  name: string;
  roomId: string;
  roomName: string;
  stateTopic: string;
  eventType: SecurityEventType;
  zoneId: string;
}

const DEFAULT_REFRESH_MS = 5 * 60_000;
/** Finestra di deduplica degli audit `info` (impianto disinserito). */
const AUDIT_DEDUPE_MS = 60_000;

function asEventType(value: string | null): SecurityEventType | null {
  if (
    value === 'smoke' ||
    value === 'flood' ||
    value === 'gas' ||
    value === 'co' ||
    value === 'motion' ||
    value === 'contact' ||
    value === 'tamper' ||
    value === 'intrusion'
  ) {
    return value;
  }
  return null;
}

function asZoneKind(value: string | null): SecurityZoneKind {
  return value === 'emergency' || value === 'perimeter' || value === 'interior'
    ? value
    : 'interior';
}

const triggerSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  eventType: z
    .enum(['smoke', 'flood', 'gas', 'co', 'motion', 'contact', 'tamper', 'intrusion'])
    .optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  /** `false`/`state: "clear"` dichiarano il rientro del sensore. */
  value: z.boolean().optional(),
  state: z.enum(['alarm', 'clear']).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export interface AlarmManagerOptions {
  db: Database;
  /** Solo la sezione broker della configurazione (`url: null` = nessun ascolto). */
  config: Pick<AuthConfig, 'mqtt'>;
  log?: FastifyBaseLogger;
  /** Collegamento MQTT già costruito: nei test si inietta un falso spia. */
  link?: MqttLink;
  /** Bus real-time condiviso con le rotte; default: uno interno. */
  events?: SecurityEventBus;
  /** Ogni quanto rileggere l'anagrafica sensori (default 5 min). */
  refreshMs?: number;
  /** Orologio iniettabile: rende deterministico il dedupe degli audit. */
  now?: () => number;
}

export interface AlarmManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Gestisce un messaggio MQTT (topic relativo a `MQTT_BASE_TOPIC`). */
  handleMessage(topic: string, payload: string): Promise<void>;
  /** Rilegge sensori e mappature dal database, riallineando le sottoscrizioni. */
  refreshSensors(): Promise<void>;
  /** Sensori attualmente monitorati (diagnostica e test). */
  sensors(): SecuritySensor[];
  /** Topic sottoscritti, wildcard inclusa. */
  subscriptions(): string[];
  /** Contatti/manomissioni aperti: bloccano l'armamento. */
  openSensors(): OpenSensor[];
  /** Snapshot corrente (stato, zone, allarmi aperti). */
  snapshot(): Promise<SecuritySnapshot>;
}

export function createAlarmManager(options: AlarmManagerOptions): AlarmManager {
  const { db, config, log } = options;
  const now = options.now ?? Date.now;
  const refreshMs = Math.max(30_000, options.refreshMs ?? DEFAULT_REFRESH_MS);
  const events = options.events ?? createSecurityEventBus(log);

  let link: MqttLink | null = null;
  let ownsLink = false;
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Mappa topic → sensore: il percorso caldo di un messaggio è un lookup. */
  let byTopic = new Map<string, SecuritySensor>();
  let zones = new Map<string, ZonePolicy>();
  const subscribed = new Set<string>();
  const open = new Map<string, OpenSensor>();
  const lastAudit = new Map<string, number>();

  async function readZones(): Promise<Map<string, ZonePolicy>> {
    const result = await db.client.query<ZoneRow>(
      `SELECT id, kind, arm_home, arm_away FROM security_zones`,
    );
    return new Map(
      result.rows.map((row) => [
        row.id,
        { kind: asZoneKind(row.kind), armHome: row.arm_home, armAway: row.arm_away },
      ]),
    );
  }

  function subscribe(topic: string): void {
    if (subscribed.has(topic)) return;
    subscribed.add(topic);
    link?.subscribe(topic);
  }

  function unsubscribe(topic: string): void {
    if (!subscribed.delete(topic)) return;
    link?.unsubscribe(topic);
  }

  async function refreshSensors(): Promise<void> {
    zones = await readZones();

    const result = await db.client.query<SensorRow>(
      `SELECT d.id, d.name, d.room_id, r.name AS room_name, d.state_topic,
              d.metadata->'state'->>'type' AS state_type,
              m.zone_id, m.event_type,
              z.kind, z.arm_home, z.arm_away
       FROM devices d
       LEFT JOIN rooms r ON r.id = d.room_id
       LEFT JOIN security_zone_devices m ON m.device_id = d.id
       LEFT JOIN security_zones z ON z.id = m.zone_id
       WHERE d.type = 'sensor'
       ORDER BY d.display_order, d.id`,
    );

    const next = new Map<string, SecuritySensor>();

    for (const row of result.rows) {
      const topic = (row.state_topic ?? '').trim();
      if (topic.length === 0) continue;

      const mappedEventType = asEventType(row.event_type);
      const mappedZone = row.zone_id ? zones.get(row.zone_id) : undefined;
      const profile = sensorProfile(row.state_type);

      // La mappatura esplicita vince; altrimenti il sensore viene associato
      // alla zona di default del suo tipo, una sola volta.
      let eventType = mappedEventType;
      let zoneId = row.zone_id;
      let zone: ZonePolicy | undefined = mappedZone;

      if (!eventType || !zoneId || !zone) {
        if (!profile) continue;
        eventType = eventType ?? profile.eventType;
        zoneId = zoneId ?? profile.zoneId;
        zone = zones.get(zoneId) ?? { kind: 'interior', armHome: true, armAway: true };

        if (!row.zone_id) {
          await db.client.query(
            `INSERT INTO security_zone_devices (device_id, zone_id, event_type)
             VALUES ($1, $2, $3)
             ON CONFLICT (device_id) DO NOTHING`,
            [row.id, zoneId, eventType],
          );
        }
      }

      next.set(topic, {
        deviceId: row.id,
        name: row.name,
        roomId: row.room_id,
        roomName: row.room_name ?? row.room_id,
        stateTopic: topic,
        eventType,
        zoneId: zoneId as string,
        kind: zone.kind,
        armHome: zone.armHome,
        armAway: zone.armAway,
      });
    }

    for (const topic of next.keys()) subscribe(topic);
    for (const topic of [...subscribed]) {
      if (topic === SECURITY_WILDCARD) continue;
      if (!next.has(topic)) unsubscribe(topic);
    }

    byTopic = next;
    log?.info(`sicurezza: ${next.size} sensori monitorati in ${zones.size} zone`);
  }

  async function publish(type: SecurityEventKind, extra: Partial<SecurityStateEvent> = {}): Promise<void> {
    const snapshot = await readSecuritySnapshot(db);
    events.publish({
      type,
      at: new Date(now()).toISOString(),
      status: snapshot.state.status,
      activeCount: snapshot.activeEvents.length,
      ...extra,
    });
  }

  /**
   * Valutazione di una rilevazione. Il percorso critico legge lo stato **dal
   * database**, non da una cache: due processi (o un rollback di una rotta)
   * non possono far scattare un allarme con uno stato di armamento stantio.
   */
  async function evaluate(
    sensor: SecuritySensor,
    detection: AlarmDetection,
    source: string,
  ): Promise<void> {
    if (!detection.active) {
      open.delete(sensor.deviceId);
      return;
    }

    // Contatti e manomissioni restano "aperti" finché il sensore non torna in
    // quiete: un armamento con una finestra aperta viene rifiutato.
    if (sensor.eventType === 'contact' || sensor.eventType === 'tamper') {
      open.set(sensor.deviceId, {
        deviceId: sensor.deviceId,
        name: sensor.name,
        roomName: sensor.roomName,
        eventType: sensor.eventType,
        since: new Date(now()).toISOString(),
      });
    }

    const state = await readSecurityState(db);
    const payload = {
      topic: source,
      field: detection.field,
      ...(detection.body ? { data: detection.body } : {}),
    };

    if (!isLifeSafetyEvent(sensor.eventType) && !zoneArmed(sensor, state.status)) {
      // Impianto disinserito: nessun allarme, ma la rilevazione resta
      // tracciata come audit già chiuso. Il dedupe in memoria evita una riga
      // per ogni ripetizione dello stesso payload.
      const key = `${sensor.deviceId}:${sensor.eventType}`;
      const at = now();
      const previous = lastAudit.get(key) ?? 0;
      if (at - previous < AUDIT_DEDUPE_MS) return;
      lastAudit.set(key, at);

      await insertSecurityEvent(db, {
        deviceId: sensor.deviceId,
        eventType: sensor.eventType,
        severity: 'info',
        payload,
        notes: `Rilevazione a impianto ${state.status}`,
        resolvedAt: new Date(at),
      });
      return;
    }

    const created = await insertSecurityEvent(db, {
      deviceId: sensor.deviceId,
      eventType: sensor.eventType,
      severity: 'critical',
      payload,
    });

    // `null` = esiste già un evento aperto per questo sensore (retained
    // rielaborato, raffica di riconnessione, secondo worker): niente doppioni.
    if (!created) return;

    await triggerSystem(db);
    await publish('triggered', {
      eventId: created.id,
      deviceId: sensor.deviceId,
      eventType: sensor.eventType,
    });

    log?.warn(
      `sicurezza: allarme ${sensor.eventType} da ${sensor.deviceId} (${sensor.roomName}) · stato ${state.status}`,
    );
  }

  async function handleTrigger(rawPayload: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      log?.warn('sicurezza: payload di security/trigger non è JSON valido');
      return;
    }

    const result = triggerSchema.safeParse(parsed);
    if (!result.success) {
      log?.warn('sicurezza: payload di security/trigger non valido');
      return;
    }

    const command = result.data;
    const sensor = [...byTopic.values()].find((entry) => entry.deviceId === command.deviceId);
    const eventType = command.eventType ?? sensor?.eventType ?? 'intrusion';
    const active = command.state === 'clear' ? false : (command.value ?? true);

    // Un dispositivo non censito non può rispettare la foreign key di
    // `security_events`: il comando viene rifiutato invece di far fallire la
    // scrittura con un errore SQL.
    if (!sensor) {
      const exists = await db.client.query<{ id: string }>(
        `SELECT id FROM devices WHERE id = $1`,
        [command.deviceId],
      );
      if (exists.rows.length === 0) {
        log?.warn(`sicurezza: trigger per device sconosciuto ${command.deviceId}`);
        return;
      }
    }

    const target: SecuritySensor = sensor ?? {
      deviceId: command.deviceId,
      name: command.deviceId,
      roomId: '',
      roomName: '',
      stateTopic: SECURITY_TRIGGER_TOPIC,
      eventType,
      zoneId: 'emergency',
      kind: 'emergency',
      armHome: true,
      armAway: true,
    };

    await evaluate(
      target,
      {
        active,
        field: 'security/trigger',
        body: command.payload ?? { ...command },
      },
      SECURITY_TRIGGER_TOPIC,
    );
  }

  async function handleMessage(topic: string, payload: string): Promise<void> {
    const relative = topic.trim().replace(/^\/+/, '');
    if (relative === SECURITY_TRIGGER_TOPIC) {
      await handleTrigger(payload);
      return;
    }

    const sensor = byTopic.get(relative);
    if (!sensor) return;

    const detection = detectSecurityAlarm(sensor.eventType, payload);
    if (!detection) return;

    await evaluate(sensor, detection, relative);
  }

  return {
    async start() {
      if (started) return;
      started = true;

      if (!link) {
        link = options.link ?? createMqttLink(config.mqtt, {
          clientId: `wallos-security-${process.pid}-${Math.random().toString(16).slice(2, 6)}`,
          log,
        });
        ownsLink = options.link === undefined;
      }

      link.onMessage((topic, payload) => {
        void handleMessage(topic, payload).catch((error: unknown) => {
          log?.warn(
            `sicurezza: messaggio ${topic} non gestito: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      });

      // Le sottoscrizioni raccolte prima di `start()` (es. `refreshSensors()`
      // chiamato nei test o all'avvio) vanno riversate sul link appena esiste:
      // `subscribe()` è idempotente sul set interno e non le ripeterebbe.
      for (const topic of subscribed) link.subscribe(topic);

      // Gli eventi delle rotte REST (arm/disarm/ack) arrivano al broker dallo
      // stesso link: una sola connessione, un solo punto di publish retained.
      events.attachMqtt((event) => {
        link?.publish(SECURITY_ALARM_STATE_TOPIC, JSON.stringify(event), { retain: true });
      });

      await refreshSensors();
      subscribe(SECURITY_WILDCARD);

      // Stato iniziale retained: un client che si collega dopo un blackout vede
      // subito com'è messa la casa, senza aspettare il prossimo allarme.
      const snapshot = await readSecuritySnapshot(db);
      link.publish(
        SECURITY_ALARM_STATE_TOPIC,
        JSON.stringify({
          status: snapshot.state.status,
          type: 'snapshot',
          at: new Date(now()).toISOString(),
          activeCount: snapshot.activeEvents.length,
          armedAt: snapshot.state.armedAt,
          disarmedAt: snapshot.state.disarmedAt,
        }),
        { retain: true },
      );

      timer = setInterval(() => {
        void refreshSensors().catch((error: unknown) => {
          log?.warn(
            `sicurezza: rilettura sensori fallita: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }, refreshMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      log?.info(
        link.enabled
          ? 'sicurezza: worker in ascolto sul broker (allarmi persistiti anche senza browser)'
          : 'sicurezza: broker non configurato, il worker resta inerte (nessun allarme rilevato)',
      );
    },

    async stop() {
      started = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      open.clear();
      lastAudit.clear();
      if (!link) return;
      if (ownsLink) await link.close();
      link = null;
    },

    handleMessage,

    refreshSensors,

    sensors: () => [...byTopic.values()],

    subscriptions: () => [...subscribed],

    openSensors: () => [...open.values()],

    snapshot: () => readSecuritySnapshot(db),
  };
}
