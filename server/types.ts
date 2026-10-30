import type { DevicePinPosition, RoomGridLayout } from '../src/types/floorplan.js';

export type UserRole = 'admin' | 'family' | 'guest' | 'kiosk';

export type SessionKind = 'user' | 'kiosk';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  role: UserRole;
  pin_hash: string;
  pin_length: number;
  is_kiosk_device: boolean;
  kiosk_device_id: string | null;
  allowed_rooms: string[] | null;
  active: boolean;
  last_access: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  kind: SessionKind;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  replaced_by: string | null;
  user_agent: string | null;
  created_at: Date | string;
}

export interface AttemptRow {
  key: string;
  failures: number;
  window_started_at: Date | string;
  locked_until: Date | string | null;
  updated_at: Date | string;
}

export interface RoomRow {
  id: string;
  name: string;
  short_label: string | null;
  icon: string;
  display_order: number;
  /** Piano della planimetria; `null` = stanza non assegnata. */
  floor_id: string | null;
  /** Rettangolo sulla griglia 12×8 (JSONB, normalizzato in lettura). */
  grid_layout: RoomGridLayout;
}

/** Riga di `floors`: un livello della planimetria schematica. */
export interface FloorRow {
  id: string;
  name: string;
  level_order: number;
  icon: string;
  created_at: Date | string;
}

/** Campi modificabili di un piano (l'id è la chiave, non si riscrive). */
export interface FloorFields {
  name: string;
  level_order: number;
  icon: string;
}

export interface DeviceRow {
  id: string;
  room_id: string;
  name: string;
  type: 'light' | 'climate' | 'power' | 'media' | 'sensor' | 'camera';
  adapter: string;
  model: string | null;
  state_topic: string;
  command_topic: string | null;
  availability_topic: string | null;
  field_map: Record<string, string> | null;
  stream_url: string | null;
  snapshot_url: string | null;
  stream_protocol: 'webrtc' | 'hls' | 'mjpeg' | 'auto' | null;
  aspect_ratio: '16:9' | '4:3' | null;
  metadata: Record<string, unknown>;
  favorite: boolean;
  protected: boolean;
  display_order: number;
  /** Marker nella planimetria della stanza, in percentuale (0-100). */
  room_pin_position: DevicePinPosition;
}

/** Preset del cronotermostato: non è la modalità del firmware. */
export type ClimatePreset = 'comfort' | 'eco' | 'auto' | 'off';

/** Riga di `climate_schedules`: `NUMERIC` e `TIME` arrivano come stringhe da PG. */
export interface ClimateScheduleRow {
  id: string;
  device_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  target_temp: string | number;
  hvac_mode: string;
  is_active: boolean;
}

/** Riga di `climate_runtime_states`: override, vacanza e ultimo comando. */
export interface ClimateRuntimeRow {
  device_id: string;
  override_target_temp: string | number | null;
  override_hvac_mode: string | null;
  override_until: Date | string | null;
  vacation_mode: boolean;
  vacation_until: Date | string | null;
  last_sent_target_temp: string | number | null;
  last_sent_hvac_mode: string | null;
  last_sent_at: Date | string | null;
  updated_at: Date | string;
}

export interface ScenarioRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  protected: boolean;
  actions: unknown;
  display_order: number;
}

/** Payload JWT: nessun dato sensibile, solo identità e scope. */
export interface AccessClaims {
  sub: string;
  role: UserRole;
  typ: 'access' | 'kiosk' | 'switch';
  /** Famiglia della sessione: lega elevazione e refresh alla stessa catena. */
  sid: string;
  /** Attore originale quando la sessione è un cambio profilo temporaneo. */
  act?: string;
}

export interface ElevationClaims {
  sub: string;
  sid: string;
  purpose: 'elevation';
  exp?: number;
}

/** Profilo restituito al client: mai hash, mai flag interni ambigui. */
export interface PublicUser {
  id: string;
  username: string;
  name: string;
  initials: string;
  role: UserRole;
  /** `null` = tutte le stanze. */
  allowedRooms: string[] | null;
  active: boolean;
  isKioskDevice: boolean;
  /** Identificativo del pannello per l'accesso kiosk (pubblico, non segreto). */
  kioskDeviceId: string | null;
  lastAccess: string | null;
  pinLength: 4 | 5 | 6;
}

export interface PinPolicy {
  minLength: number;
  maxLength: number;
  maxAttempts: number;
  lockoutMs: number;
}

export interface SessionResponse {
  user: PublicUser;
  pinPolicy: PinPolicy;
  elevated: boolean;
  elevatedUntil: number | null;
  temporary: boolean;
}

export interface AttemptPolicy {
  maxAttempts: number;
  lockoutMs: number;
  /** Oltre questa finestra i fallimenti non contano più. */
  windowMs: number;
}

/**
 * Pubblicazione degli eventi di topologia sul broker MQTT condiviso.
 * `url: null` (nessuna variabile impostata) disabilita la pubblicazione.
 */
export interface MqttEventsConfig {
  /** Es. `mqtt://192.168.0.10:1883` (listener TCP del broker). */
  url: string | null;
  username: string | null;
  password: string | null;
  /** Prefisso applicato a tutti i topic, come `MQTT_BASE_TOPIC` sul client. */
  baseTopic: string;
}

// ── Display a parete (Kiosk Profiles) ──────────────────────────────────────

/** Modalità dello screensaver del pannello. */
export type KioskScreensaverMode = 'clock_float' | 'black' | 'off';

export type KioskOrientation = 'landscape' | 'portrait';

/** Riga di `kiosk_displays`: la configurazione hardware di un tablet. */
export interface KioskDisplayRow {
  id: string;
  name: string;
  default_room_id: string | null;
  dimmer_timeout_sec: number;
  dimmer_screensaver_mode: KioskScreensaverMode;
  performance_mode: boolean;
  high_contrast: boolean;
  pin_required: boolean;
  screen_orientation: KioskOrientation;
  is_active: boolean;
  last_seen_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Campi modificabili dal pannello o dall'amministratore. */
export interface KioskDisplayFields {
  name: string;
  default_room_id: string | null;
  dimmer_timeout_sec: number;
  dimmer_screensaver_mode: KioskScreensaverMode;
  performance_mode: boolean;
  high_contrast: boolean;
  pin_required: boolean;
  screen_orientation: KioskOrientation;
  is_active: boolean;
}

/** Payload pubblicato su `wallos/system/kiosk/:id/config_updated`. */
export interface KioskConfigEvent {
  id: string;
  config: unknown;
  timestamp: number;
  /** Pannello che ha fatto la modifica: quello stesso client può saltare il toast. */
  sourceClientId?: string;
}

// ── Motore di automazioni (Trigger → Conditions → Actions) ──────────────────

/** Tipo di trigger: messaggio MQTT, espressione cron, evento solare. */
export type AutomationTriggerType = 'mqtt_state' | 'time_cron' | 'sun_event';

export type SunEventName = 'sunrise' | 'sunset';

/**
 * `trigger_config` è JSONB e la forma dipende da `trigger_type`: il motore
 * ricostruisce la variante prima di valutarla, così una riga scritta a mano nel
 * database non fa esplodere il tick.
 */
export interface MqttStateTriggerConfig {
  topic: string;
  /** Chiave da estrarre dal payload JSON (assente = confronto sul payload). */
  payloadKey?: string;
  expectedValue?: string | number | boolean;
}

export interface TimeCronTriggerConfig {
  /** Espressione cron a 5 campi: minuto ora giorno-del-mese mese giorno-sett. */
  cron: string;
}

export interface SunEventTriggerConfig {
  event: SunEventName;
  /** Sfasamento in minuti rispetto all'effemeride (negativo = prima). */
  offsetMinutes?: number;
}

export type AutomationTriggerConfig =
  | MqttStateTriggerConfig
  | TimeCronTriggerConfig
  | SunEventTriggerConfig;

export interface TimeRangeCondition {
  type: 'time_range';
  /** `HH:MM`; un intervallo che scavalca la mezzanotte (23:00 → 06:00) è valido. */
  start: string;
  end: string;
}

export interface DeviceStateCondition {
  type: 'device_state';
  deviceId: string;
  expectedState: string;
}

export interface UserPresentCondition {
  type: 'user_present';
  requireHome: boolean;
}

export type AutomationCondition =
  | TimeRangeCondition
  | DeviceStateCondition
  | UserPresentCondition;

/**
 * Comando MQTT diretto. `type` è opzionale perché le regole salvate prima della
 * migrazione 005 non lo hanno: assente vale `mqtt`.
 */
export interface MqttAutomationAction {
  type?: 'mqtt';
  topic: string;
  payload: string;
  /** Attesa prima dell'invio (0 = subito). */
  delayMs?: number;
}

/**
 * Esecuzione di uno scenario salvato in `scenarios`: è il pulsante "one-touch"
 * del pannello, eseguito dal motore anche a schermo spento. I comandi li
 * traduce `server/services/commandEncoder.ts`, con gli stessi dialetti degli
 * adapter del client.
 */
export interface ScenarioAutomationAction {
  type: 'scenario';
  scenarioId: string;
  /** Attesa prima di iniziare lo scenario (0 = subito). */
  delayMs?: number;
}

export type AutomationAction = MqttAutomationAction | ScenarioAutomationAction;

/** Riga di `automations`: la forma delle colonne JSONB è validata dalle route. */
export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  trigger_type: string;
  trigger_config: unknown;
  /** Primo gruppo di condizioni, in AND. */
  conditions: unknown;
  /** Altri gruppi di condizioni: AND dentro il gruppo, OR fra i gruppi. */
  condition_groups: unknown;
  actions: unknown;
  last_triggered_at: Date | string | null;
  execution_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  /**
   * Tempo minimo (ms) fra due esecuzioni consecutive della regola. La colonna è
   * opzionale: un'installazione che non ce l'ha usa `DEFAULT_AUTOMATION_THROTTLE_MS`.
   * Il motore la applica insieme al lock per chiave, così un burst di messaggi
   * MQTT non comanda due volte lo stesso relè.
   */
  throttle_ms?: number | null;
}

/** Riga di `automations` più l'esito dell'ultima esecuzione registrata. */
export interface AutomationWithLastLogRow extends AutomationRow {
  last_log_at: Date | string | null;
  last_log_conditions_met: boolean | null;
  last_log_execution_time_ms: number | null;
  last_log_error: string | null;
}

/** Riga di `automation_logs`. */
export interface AutomationLogRow {
  id: string | number;
  automation_id: string;
  triggered_at: Date | string;
  trigger_source: string;
  conditions_met: boolean;
  actions_executed: unknown;
  execution_time_ms: number;
  error_message: string | null;
}

/** Esito di un singolo comando pubblicato (o non pubblicato) sul broker. */
export interface AutomationCommandOutcome {
  /** Assenti quando il passo è stato scartato prima di avere un comando. */
  topic?: string;
  payload?: string;
  /** Dispositivo riconosciuto dal topic di comando, quando la mappa lo conosce. */
  deviceId?: string;
  status: 'sent' | 'skipped' | 'failed';
  error?: string;
  durationMs: number;
}

/**
 * Esito registrato per una azione della sequenza: un comando MQTT diretto
 * (`commands` con una sola voce) oppure tutti i comandi di uno scenario.
 */
export interface AutomationActionOutcome {
  type: 'mqtt' | 'scenario';
  status: 'sent' | 'skipped' | 'failed';
  commands: AutomationCommandOutcome[];
  /** Presenti solo per le azioni di tipo scenario. */
  scenarioId?: string;
  scenarioLabel?: string;
  error?: string;
  durationMs: number;
}

/**
 * Ultimo comando inviato a un dispositivo, per il badge nel pannello:
 * risponde alla domanda "quale automazione ha comandato questo device?".
 * Vive solo in memoria nel processo del motore. `at` è epoch in millisecondi.
 */
export interface DeviceAutomationActivity {
  deviceId: string;
  automationId: string;
  automationName: string;
  triggerSource: string;
  scenarioId: string | null;
  scenarioLabel: string | null;
  topic: string;
  payload: string;
  at: number;
}

/**
 * Automazioni viste dal motore: configurazione risolta da `resolveAutomation`
 * (`server/services/automationEngine.ts`) e pronta per la valutazione.
 */
export interface ResolvedAutomation {
  id: string;
  name: string;
  isActive: boolean;
  triggerType: AutomationTriggerType;
  /** `null` quando `trigger_config` non è utilizzabile: la regola resta visibile ma inerte. */
  trigger: AutomationTriggerConfig | null;
  /** Primo gruppo di condizioni, in AND. */
  conditions: AutomationCondition[];
  /** Altri gruppi: AND dentro il gruppo, OR fra i gruppi (e con `conditions`). */
  conditionGroups: AutomationCondition[][];
  actions: AutomationAction[];
  /**
   * Finestra di deduplicazione fra due esecuzioni della stessa regola, in ms.
   * `0` disabilita il cooldown (solo per regole che devono reagire a ogni
   * transizione); il valore arriva da `automations.throttle_ms` e viene
   * limitato da `resolveAutomation`.
   */
  throttleMs: number;
  /** Motivo dello scarto, per log e diagnostica. */
  invalidReason: string | null;
}

/**
 * Parametri del motore di automazioni che non hanno un default sensato:
 * coordinate per alba/tramonto e topic di presenza.
 */
export interface AutomationConfig {
  /** Latitudine in gradi decimali; `null` = regole solari disabilitate. */
  latitude: number | null;
  /** Longitudine in gradi decimali (est positiva). */
  longitude: number | null;
  /** Topic che veicola la presenza in casa; `null` = condizione `user_present` inerte. */
  presenceTopic: string | null;
}

export interface SeedConfig {
  /**
   * `AUTO_SEED=true`: abilita l'inserimento dei dati demo all'avvio, e solo su
   * database vuoto. Default `false`: il bootstrap non scrive mai dati mock.
   */
  autoSeed: boolean;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminPin: string;
  kioskUsername: string;
  kioskDisplayName: string;
  kioskDeviceId: string;
  kioskPin: string;
}

export interface AuthConfig {
  nodeEnv: string;
  host: string;
  port: number;
  /** URL completa usata dal pool (mai loggata: contiene la password). */
  databaseUrl: string;
  /** Da dove arriva la connessione: `DATABASE_URL` ha la precedenza su `DB_*`. */
  databaseUrlSource: 'DATABASE_URL' | 'DB_*';
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPoolMax: number;
  dbSsl: boolean;
  dbConnectTimeoutMs: number;
  dbIdleTimeoutMs: number;
  jwtSecret: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  corsOrigins: string[];
  accessTtlSec: number;
  refreshTtlSec: number;
  kioskRefreshTtlSec: number;
  elevationTtlSec: number;
  switchTtlSec: number;
  bcryptRounds: number;
  pinPolicy: PinPolicy & { windowMs: number };
  loginPolicy: AttemptPolicy;
  mqtt: MqttEventsConfig;
  automation: AutomationConfig;
  seed: SeedConfig;
}
