/**
 * Worker di ingestion della telemetria energetica.
 *
 * Il browser vede i dati istantanei via MQTT-over-WebSocket, ma il pannello può
 * essere spento: senza un processo che ascolti il listener TCP del broker e
 * scriva su PostgreSQL, `telemetry_history` resta vuota e i grafici 24h/7d/30d
 * di `EnergyPage` non hanno nulla da mostrare.
 *
 * Il worker:
 * 1. legge da `devices` i dispositivi con meter di potenza (`type = 'power'`,
 *    più i sensori il cui stato dichiara `power`/`energy`);
 * 2. si sottoscrive, per ognuno, al proprio topic di stato e ai pattern di
 *    telemetria del firmware (`stat/<device>/#`, `tele/<device>/#` per Tasmota,
 *    `shellies/<device>/#` e `shelly/<stanza>/<nome>/#` per Shelly Gen1/Gen2).
 *    Le wildcard sono sempre radicate su un device noto: un messaggio senza
 *    `devices.id` non può rispettare la foreign key di `telemetry_history`;
 * 3. normalizza payload eterogenei (`apower`, `Power`, `powerWatts`, `W`,
 *    `aenergy.total`, `ENERGY.Total`, …) in `power_watts` / `energy_kwh`,
 *    ignorando JSON malformati, valori non numerici e NaN;
 * 4. campiona al massimo un valore per device+metrica ogni
 *    `sampleIntervalMs` (default 60 s) e inserisce in batch, così un meter che
 *    pubblica ogni secondo non satura il database;
 * 5. sopravvive a broker e database irraggiungibili: l'errore viene loggato e
 *    il worker resta in ascolto, senza terminare il processo.
 *
 * Il ciclo di vita (`start()`/`stop()`) lo pilota `server/index.ts`: nei test
 * `buildApp` resta senza socket e senza timer.
 */

import type { FastifyBaseLogger } from 'fastify';

import type { Database } from '../db.js';
import { createMqttLink, type MqttLink } from '../mqttClient.js';
import type { AuthConfig } from '../types.js';

/** Stesse metriche accettate da `GET /api/telemetry/history`. */
export type TelemetryMetricType = 'power_watts' | 'energy_kwh' | 'temperature' | 'humidity';

/** Campione pronto per la `INSERT` in `telemetry_history`. */
export interface TelemetrySample {
  deviceId: string;
  metricType: TelemetryMetricType;
  value: number;
  recordedAt: Date;
}

export interface TelemetryWorkerOptions {
  db: Database;
  /** Solo la sezione broker della configurazione (`url: null` = ingestion spenta). */
  config: Pick<AuthConfig, 'mqtt'>;
  log?: FastifyBaseLogger;
  /**
   * Intervallo minimo fra due campioni dello stesso device+metrica.
   * Default 60 s, validato fra 10 s e 15 min.
   */
  sampleIntervalMs?: number;
  /** Collegamento MQTT già costruito: nei test si inietta un falso spia. */
  link?: MqttLink;
  /** Ogni quanto svuotare il buffer (default 2 s). */
  flushIntervalMs?: number;
  /** Ogni quanto rileggere l'anagrafica device (default 5 min). */
  deviceRefreshMs?: number;
}

export interface TelemetryWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Gestisce un messaggio MQTT (topic relativo a `MQTT_BASE_TOPIC`). */
  handleMessage(topic: string, payload: string): void;
  /** Riallinea sottoscrizioni e indice device all'anagrafica corrente. */
  refreshDevices(): Promise<void>;
  /** Scrive subito i campioni in buffer. */
  flush(): Promise<void>;
  /** Topic attualmente sottoscritti (diagnostica e test). */
  subscriptions(): string[];
}

/** Riga minima di `devices` usata dal worker. */
interface DeviceTelemetryRow {
  id: string;
  type: string;
  adapter: string;
  state_topic: string;
  field_map: Record<string, string> | null;
  metadata: unknown;
}

interface MonitoredDevice {
  id: string;
  stateTopic: string;
  /** Chiave normalizzata del topic (`kitchen/oven`, `study/desk`, …). */
  key: string;
  fieldMap: Record<string, string> | null;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const MIN_SAMPLE_INTERVAL_MS = 10_000;
const MAX_SAMPLE_INTERVAL_MS = 15 * 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const MIN_FLUSH_INTERVAL_MS = 500;
const DEVICE_REFRESH_MS = 5 * 60_000;
const MAX_BUFFERED_SAMPLES = 1_000;
const FLUSH_THRESHOLD = 200;

/** Oltre questi limiti il payload è rumore (o un contatore corrotto). */
const MAX_POWER_W = 1_000_000;
const MAX_ENERGY_KWH = 10_000_000;

/** Unità di misura: la scala porta il valore a kWh. */
interface MetricCandidate {
  path: string;
  scale?: number;
}

const POWER_CANDIDATES: readonly MetricCandidate[] = [
  { path: 'powerWatts' },
  { path: 'power_watts' },
  { path: 'apower' },
  { path: 'watts' },
  { path: 'power' },
  { path: 'activePower' },
  { path: 'active_power' },
  { path: 'meter.power' },
  { path: 'ENERGY.Power' },
];

const ENERGY_CANDIDATES: readonly MetricCandidate[] = [
  { path: 'energyKwh' },
  { path: 'energy_kwh' },
  { path: 'totalKwh' },
  { path: 'total_kwh' },
  { path: 'meter.kwh' },
  // Shelly espone i contatori in Wh: 1234.5 Wh → 1,2345 kWh.
  { path: 'aenergy.total', scale: 0.001 },
  { path: 'emeter.total', scale: 0.001 },
  // Tasmota `tele/<device>/SENSOR` → ENERGY.Total in kWh.
  { path: 'ENERGY.Total' },
  { path: 'energy' },
  { path: 'total' },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** JSON di oggetto; `null` per array, scalari e payload malformati. */
function parseJsonRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Legge un path puntato (`aenergy.total`) senza assumere la capitalizzazione. */
function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    const node = current as Record<string, unknown>;
    if (segment in node) {
      current = node[segment];
      continue;
    }
    const match = Object.keys(node).find((key) => key.toLowerCase() === segment.toLowerCase());
    if (match === undefined) return undefined;
    current = node[match];
  }
  return current;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  candidates: readonly MetricCandidate[],
): number | undefined {
  for (const candidate of candidates) {
    const raw = asFiniteNumber(readPath(record, candidate.path));
    if (raw === undefined) continue;
    const scaled = raw * (candidate.scale ?? 1);
    if (!Number.isFinite(scaled)) continue;
    return scaled;
  }
  return undefined;
}

/** Messaggio relativo al solo contatore energia, senza JSON (`"1234"`). */
function isEnergyTopic(topic: string): boolean {
  return /(?:^|\/)(?:energy|emeter|kwh)(?:\/|$)/i.test(topic);
}

/** I contatori `shellies/<device>/relay/N/energy` sono in Wh; il resto in kWh. */
function energyScaleForTopic(topic: string): number {
  return /^shellies\//i.test(topic) || /\/emeter(?:\/|$)/i.test(topic) ? 0.001 : 1;
}

/** Valori normalizzati estratti da un payload eterogeneo. */
export interface NormalizedTelemetry {
  powerWatts?: number;
  energyKwh?: number;
}

/**
 * Normalizza il payload di un meter in `power_watts` / `energy_kwh`.
 *
 * Accetta JSON annidati (Shelly Gen2 `apower`/`aenergy`, Tasmota
 * `ENERGY.Power`/`ENERGY.Total`), JSON custom con `fieldMap` del device e
 * numeri in chiaro sui topic `.../power` e `.../energy`. Un payload che non
 * contiene una metrica valida restituisce `{}`: il chiamante non scrive nulla.
 */
export function normalizeTelemetryPayload(
  topic: string,
  payload: string,
  fieldMap?: Record<string, string> | null,
): NormalizedTelemetry {
  const text = payload.trim();
  if (text.length === 0) return {};

  const record = parseJsonRecord(text);
  if (!record) {
    const numeric = asFiniteNumber(text);
    if (numeric === undefined) return {};
    if (isEnergyTopic(topic)) {
      const energyKwh = numeric * energyScaleForTopic(topic);
      if (energyKwh < 0 || energyKwh > MAX_ENERGY_KWH) return {};
      return { energyKwh: round2(energyKwh) };
    }
    if (Math.abs(numeric) > MAX_POWER_W) return {};
    return { powerWatts: round2(numeric) };
  }

  // Il `fieldMap` del device ha la precedenza: è la mappa configurata in admin
  // per un firmware che non segue nessuno dei dialetti supportati.
  const powerCandidates: MetricCandidate[] = [];
  const mappedPower = fieldMap?.['watts'] ?? fieldMap?.['power'];
  if (mappedPower) powerCandidates.push({ path: mappedPower });
  powerCandidates.push(...POWER_CANDIDATES);

  const energyCandidates: MetricCandidate[] = [];
  const mappedEnergy = fieldMap?.['energyTotalKwh'] ?? fieldMap?.['energyKwh'];
  if (mappedEnergy) energyCandidates.push({ path: mappedEnergy });
  energyCandidates.push(...ENERGY_CANDIDATES);

  const normalized: NormalizedTelemetry = {};
  const power = pickNumber(record, powerCandidates);
  if (power !== undefined && Math.abs(power) <= MAX_POWER_W) {
    normalized.powerWatts = round2(power);
  }
  const energy = pickNumber(record, energyCandidates);
  if (energy !== undefined && energy >= 0 && energy <= MAX_ENERGY_KWH) {
    normalized.energyKwh = round2(energy);
  }
  return normalized;
}

const PROTOCOL_HEADERS = new Set(['stat', 'tele', 'cmnd']);
const SHELLY_TAIL_MARKERS = new Set([
  'status',
  'rpc',
  'events',
  'online',
  'settings',
  'profile',
  'components',
]);

/**
 * Chiave stabile di un topic di telemetria: rimuove protocollo e campo finale
 * così `stat/kitchen/oven/POWER`, `tele/kitchen/oven/SENSOR` e
 * `shelly/study/desk/status/switch:0` restano attribuibili a un device.
 */
export function telemetryTopicKey(topic: string): string {
  const segments = topic
    .trim()
    .split('/')
    .filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head === undefined) return '';

  const rest = segments.slice(1);
  if (PROTOCOL_HEADERS.has(head)) {
    // Tasmota: stat/<stanza>/<nome>/POWER → "stanza/nome".
    if (rest.length <= 1) return rest[0] ?? '';
    return rest.slice(0, -1).join('/');
  }
  if (head === 'shellies') return rest[0] ?? '';
  if (head === 'shelly') {
    const end = rest.findIndex((segment) => SHELLY_TAIL_MARKERS.has(segment));
    return (end === -1 ? rest : rest.slice(0, end)).join('/');
  }
  return segments.join('/');
}

/**
 * Topic da sottoscrivere per un device: lo stato esatto più le wildcard del
 * firmware, radicate sulla chiave del device (mai `+/...` generici, altrimenti
 * un campione non avrebbe un `devices.id` a cui appartenere).
 */
export function telemetrySubscriptionTopics(stateTopic: string): string[] {
  const trimmed = stateTopic.trim();
  const segments = trimmed.split('/').filter((segment) => segment.length > 0);
  const head = segments[0];
  const key = telemetryTopicKey(trimmed);
  if (key.length === 0) return [];

  if (head === 'stat' || head === 'tele') {
    return [trimmed, `stat/${key}/#`, `tele/${key}/#`];
  }
  if (head === 'shellies' || head === 'shelly') {
    return [trimmed, `${head}/${key}/#`];
  }
  return [trimmed];
}

/** `metadata.state.type` di un sensore: `power`, `energy`, `temperature`, … */
function sensorStateType(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const state = (metadata as Record<string, unknown>)['state'];
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const type = (state as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : undefined;
}

function isMonitorableDevice(row: DeviceTelemetryRow): boolean {
  if (row.type === 'power') return true;
  if (row.type !== 'sensor') return false;
  const type = sensorStateType(row.metadata);
  return type === 'power' || type === 'energy';
}

/**
 * Insert parametrizzato (un solo statement, quindi atomico) dei campioni.
 * Restituisce le righe scritte.
 */
export async function insertTelemetrySamples(
  db: Database,
  samples: readonly TelemetrySample[],
): Promise<number> {
  if (samples.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = samples.map((sample, index) => {
    const base = index * 4;
    values.push(sample.deviceId, sample.metricType, sample.value, sample.recordedAt);
    return `($${base + 1}::text, $${base + 2}::varchar(32), $${base + 3}::numeric(10, 2), $${base + 4}::timestamptz)`;
  });

  const result = await db.client.query(
    `INSERT INTO telemetry_history (device_id, metric_type, val, recorded_at)
     VALUES ${tuples.join(', ')}`,
    values,
  );
  return result.rowCount;
}

/**
 * Scrittura immediata di un singolo campione (backfill, test, job esterni).
 * Il worker usa il percorso batch; questa funzione resta il contratto pubblico
 * per chi vuole registrare un valore già normalizzato senza passare dal broker.
 */
export async function recordTelemetrySample(
  db: Database,
  deviceId: string,
  metricType: TelemetryMetricType,
  value: number,
  recordedAt: Date = new Date(),
): Promise<void> {
  if (!Number.isFinite(value)) return;
  await insertTelemetrySamples(db, [{ deviceId, metricType, value: round2(value), recordedAt }]);
}

export function createTelemetryWorker(options: TelemetryWorkerOptions): TelemetryWorker {
  const { db, log } = options;
  const sampleIntervalMs = clamp(
    options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
    MIN_SAMPLE_INTERVAL_MS,
    MAX_SAMPLE_INTERVAL_MS,
  );
  const flushIntervalMs = Math.max(
    MIN_FLUSH_INTERVAL_MS,
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );
  const deviceRefreshMs = Math.max(30_000, options.deviceRefreshMs ?? DEVICE_REFRESH_MS);

  const ownsLink = options.link === undefined;
  const link: MqttLink =
    options.link ??
    createMqttLink(options.config.mqtt, {
      clientId: `wallos-telemetry-${process.pid}`,
      log,
    });

  let started = false;
  let flushing = false;
  let devices: MonitoredDevice[] = [];
  let keyIndex = new Map<string, MonitoredDevice>();
  const pending: TelemetrySample[] = [];
  const lastSampleAt = new Map<string, number>();
  const activeSubscriptions = new Set<string>();
  let flushTimer: NodeJS.Timeout | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;

  function resolveDevice(topic: string): MonitoredDevice | undefined {
    const exact = devices.find((device) => device.stateTopic === topic);
    if (exact) return exact;
    return keyIndex.get(telemetryTopicKey(topic));
  }

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const batch = pending.splice(0, pending.length);
    try {
      await insertTelemetrySamples(db, batch);
    } catch (error) {
      // Un database lento o momentaneamente giù non deve fermare l'ingestion:
      // il campione perso vale meno di un worker che smette di ascoltare.
      log?.warn(
        `telemetria: inserimento di ${batch.length} campioni fallito: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      flushing = false;
    }
  }

  function enqueue(deviceId: string, metricType: TelemetryMetricType, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = `${deviceId}:${metricType}`;
    const now = Date.now();
    const previous = lastSampleAt.get(key) ?? 0;
    // Throttling per device+metrica: la serie storica non ha bisogno di ogni
    // lettura, e un meter a 1 Hz scriverebbe 86 400 righe al giorno.
    if (now - previous < sampleIntervalMs) return;
    lastSampleAt.set(key, now);

    pending.push({ deviceId, metricType, value: round2(value), recordedAt: new Date(now) });
    if (pending.length > MAX_BUFFERED_SAMPLES) {
      pending.splice(0, pending.length - MAX_BUFFERED_SAMPLES);
      log?.warn('telemetria: buffer pieno, scartati i campioni più vecchi');
    }
    if (pending.length >= FLUSH_THRESHOLD) void flush();
  }

  function handleMessage(topic: string, payload: string): void {
    try {
      const device = resolveDevice(topic);
      if (!device) return;
      const normalized = normalizeTelemetryPayload(topic, payload, device.fieldMap);
      if (normalized.powerWatts !== undefined) {
        enqueue(device.id, 'power_watts', normalized.powerWatts);
      }
      if (normalized.energyKwh !== undefined) {
        enqueue(device.id, 'energy_kwh', normalized.energyKwh);
      }
    } catch (error) {
      // Parsing difensivo: un payload strano non deve interrompere il worker.
      log?.warn(
        `telemetria: messaggio scartato su ${topic}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function refreshDevices(): Promise<void> {
    let rows: DeviceTelemetryRow[];
    try {
      const result = await db.client.query<DeviceTelemetryRow>(
        `SELECT id, type, adapter, state_topic, field_map, metadata
         FROM devices
         WHERE type IN ('power', 'sensor')
         ORDER BY display_order, name`,
      );
      rows = result.rows;
    } catch (error) {
      log?.warn(
        `telemetria: lettura dei dispositivi fallita: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    devices = rows.filter(isMonitorableDevice).map((row) => ({
      id: row.id,
      stateTopic: row.state_topic,
      key: telemetryTopicKey(row.state_topic),
      fieldMap: row.field_map,
    }));

    keyIndex = new Map();
    for (const device of devices) {
      if (device.key.length > 0 && !keyIndex.has(device.key)) keyIndex.set(device.key, device);
    }

    const wanted = new Set<string>();
    for (const device of devices) {
      for (const topic of telemetrySubscriptionTopics(device.stateTopic)) wanted.add(topic);
    }
    for (const topic of [...activeSubscriptions]) {
      if (wanted.has(topic)) continue;
      activeSubscriptions.delete(topic);
      link.unsubscribe(topic);
    }
    for (const topic of wanted) {
      if (activeSubscriptions.has(topic)) continue;
      activeSubscriptions.add(topic);
      link.subscribe(topic);
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    link.onMessage(handleMessage);

    if (!link.enabled) {
      log?.warn(
        'telemetria: broker MQTT non configurato (MQTT_HOST/MQTT_SERVER_URL): ' +
          'nessun campione verrà salvato in telemetry_history',
      );
      return;
    }

    await refreshDevices();
    flushTimer = setInterval(() => void flush(), flushIntervalMs);
    flushTimer.unref();
    refreshTimer = setInterval(() => void refreshDevices(), deviceRefreshMs);
    refreshTimer.unref();
    log?.info(
      `telemetria: ingestion attiva · ${devices.length} dispositivi · ` +
        `campionamento ${Math.round(sampleIntervalMs / 1000)} s`,
    );
  }

  async function stop(): Promise<void> {
    started = false;
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    await flush();
    for (const topic of activeSubscriptions) link.unsubscribe(topic);
    activeSubscriptions.clear();
    if (ownsLink) await link.close();
  }

  return {
    start,
    stop,
    handleMessage,
    refreshDevices,
    flush,
    subscriptions: () => [...activeSubscriptions],
  };
}
