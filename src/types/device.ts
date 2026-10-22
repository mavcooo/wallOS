/**
 * Modello dati interno unificato.
 *
 * Qualunque sia il firmware a bordo (Zigbee2MQTT, Shelly Gen2, Tasmota o JSON
 * custom), l'interfaccia utente lavora *solo* con queste entità normalizzate.
 * La traduzione da/verso i topic MQTT vive esclusivamente in `src/mqtt/adapters`.
 */

/**
 * Le stanze non sono più un'unione chiusa: `devices.config.ts` ne fornisce un
 * seed e la discovery Home Assistant può crearne di nuove a runtime
 * (`homeStore.rooms`, con `ensureRoom`).
 */
export type RoomId = string;

export type DeviceKind = 'light' | 'climate' | 'power' | 'media' | 'sensor';

/** Identificativo dell'adapter di parsing/encoding associato al device. */
export type AdapterId = 'zigbee2mqtt' | 'shelly' | 'tasmota' | 'custom-json' | 'ha-discovery';

/** Componenti Home Assistant MQTT Discovery supportati dal bridge. */
export type HaComponent = 'light' | 'switch' | 'sensor' | 'binary_sensor' | 'climate';

/** Campi dello stato interno indirizzabili da un canale di discovery. */
export type DiscoveryField =
  | 'on'
  | 'brightness'
  | 'colorTemp'
  | 'value'
  | 'mode'
  | 'targetTemp'
  | 'currentTemp';

/** Canale di stato: un topic che porta il valore di un campo normalizzato. */
export interface DiscoveryStateChannel {
  topic: string;
  field: DiscoveryField;
  /** Come interpretare il payload: booleano, numero, stringa, 0-255 → %, mired → K. */
  kind: 'boolean' | 'number' | 'text' | 'brightness' | 'mired';
  /** Subset Jinja supportato: `{{ value_json.temperature }}`, `{{ value }}`. */
  template?: string;
  payloadOn?: string;
  payloadOff?: string;
  /** Fondo scala della luminosità dichiarato dal firmware (default 255). */
  scale?: number;
}

/** Canale di comando: topic su cui pubblicare il valore di un campo. */
export interface DiscoveryCommandChannel {
  topic: string;
  field: DiscoveryField;
  kind: 'raw' | 'brightness' | 'mired';
  payloadOn?: string;
  payloadOff?: string;
  scale?: number;
}

export interface DiscoveryAvailability {
  topic: string;
  payloadAvailable?: string;
  payloadNotAvailable?: string;
}

/**
 * Metadati dell'annuncio Home Assistant che ha generato il device: servono
 * all'adapter `ha-discovery` per decodificare i singoli topic e alla rimozione
 * per eliminare l'entità giusta.
 */
export interface DeviceDiscovery {
  /** Identità stabile dell'entità: `ha:<component>:<object_id>`. */
  entityId: string;
  /** `unique_id` dichiarato dall'annuncio, quando presente. */
  uniqueId?: string;
  component: HaComponent;
  /** Topic di discovery: base di update e deletion. */
  configTopic: string;
  /** `device.suggested_area` grezza: lo store la traduce in una stanza. */
  area?: string;
  state: DiscoveryStateChannel[];
  commands: DiscoveryCommandChannel[];
  availability: DiscoveryAvailability[];
}

export type DeviceAvailability = 'online' | 'offline' | 'unknown';

export type ClimateMode = 'off' | 'heat' | 'cool' | 'auto' | 'fan_only' | 'dry';
export type ClimateAction = 'idle' | 'heating' | 'cooling' | 'drying' | 'fan';
export type FanSpeed = 'auto' | 'low' | 'medium' | 'high';
export type SensorType =
  | 'temperature'
  | 'humidity'
  | 'co2'
  | 'contact'
  | 'motion'
  | 'illuminance'
  | 'smoke'
  | 'power'
  | 'energy';

/** Topic MQTT dichiarati in `devices.config.ts`. */
export interface DeviceTopics {
  /** Topic di stato sottoscritto in lettura. */
  state: string;
  /** Topic di comando su cui pubblicare (assente sui sensori read-only). */
  command?: string;
  /** Topic LWT/availability opzionale (payload `online`/`offline`). */
  availability?: string;
}

interface DeviceBase {
  id: string;
  name: string;
  room: RoomId;
  kind: DeviceKind;
  adapter: AdapterId;
  /** Produttore/modello mostrato nel dettaglio, non usato dalla logica. */
  model?: string;
  topics: DeviceTopics;
  /** Mappa campo normalizzato -> path JSON, usata dall'adapter `custom-json`. */
  fieldMap?: Record<string, string>;
  availability: DeviceAvailability;
  lastSeen: number | null;
  favorite: boolean;
  /** Se true, i comandi richiedono PIN (tapparelle cancello, allarme, ...). */
  protected: boolean;
  /** Presente solo sui device scoperti via Home Assistant MQTT Discovery. */
  discovery?: DeviceDiscovery;
}

export interface LightState {
  on: boolean;
  /** 0-100 */
  brightness: number;
  /** Kelvin, opzionale se il device non gestisce la temperatura colore. */
  colorTemp?: number;
}

export interface LightCapabilities {
  dimmable: boolean;
  colorTempRange?: readonly [number, number];
}

export interface LightDevice extends DeviceBase {
  kind: 'light';
  state: LightState;
  capabilities: LightCapabilities;
}

export interface ClimateState {
  mode: ClimateMode;
  /** °C, step 0.5 */
  targetTemp: number;
  currentTemp: number;
  humidity?: number;
  fanSpeed: FanSpeed;
  swing: boolean;
  action: ClimateAction;
}

export interface ClimateDevice extends DeviceBase {
  kind: 'climate';
  state: ClimateState;
  minTemp: number;
  maxTemp: number;
  tempStep: number;
}

export interface PowerState {
  on: boolean;
  /** Potenza istantanea in W. */
  watts: number;
  voltage: number;
  current: number;
  energyTodayKwh: number;
  energyTotalKwh: number;
  /** Potenza di targa / limite configurato, usato per la barra di carico. */
  maxWatts: number;
}

export interface PowerDevice extends DeviceBase {
  kind: 'power';
  state: PowerState;
}

export interface MediaState {
  power: boolean;
  volume: number;
  muted: boolean;
  source: string;
  nowPlaying: string | null;
}

export interface MediaDevice extends DeviceBase {
  kind: 'media';
  state: MediaState;
  sources: readonly string[];
}

export interface SensorState {
  value: number | boolean;
  unit: string;
  type: SensorType;
}

export interface SensorDevice extends DeviceBase {
  kind: 'sensor';
  state: SensorState;
}

export type Device = LightDevice | ClimateDevice | PowerDevice | MediaDevice | SensorDevice;

export type AnyDeviceState = Device['state'];

/**
 * Azioni astratte che l'UI può inviare. Gli adapter traducono questa union
 * nei payload specifici del firmware.
 */
export type ControlAction =
  | { type: 'power'; on: boolean }
  | { type: 'brightness'; brightness: number }
  | { type: 'colorTemp'; kelvin: number }
  | { type: 'targetTemp'; targetTemp: number }
  | { type: 'climateMode'; mode: ClimateMode }
  | { type: 'fanSpeed'; fanSpeed: FanSpeed }
  | { type: 'swing'; swing: boolean }
  | { type: 'volume'; volume: number }
  | { type: 'source'; source: string };

/** Patch normalizzata emessa da un adapter dopo il decode di un messaggio. */
export type DecodedState =
  | { kind: 'light'; state: Partial<LightState> }
  | { kind: 'climate'; state: Partial<ClimateState> }
  | { kind: 'power'; state: Partial<PowerState> }
  | { kind: 'media'; state: Partial<MediaState> }
  | { kind: 'sensor'; state: Partial<SensorState> };

export interface EncodedCommand {
  topic: string;
  payload: string;
  qos: 0 | 1;
  retain?: boolean;
}

export type ScenarioId = 'cinema' | 'goodnight' | 'away' | 'relax';

export interface ScenarioStep {
  deviceId: string;
  action: ControlAction;
  /** Ritardo progressivo in ms per evitare raffiche sul broker. */
  delayMs?: number;
}

export interface Scenario {
  id: ScenarioId;
  label: string;
  description: string;
  icon: 'clapperboard' | 'moon' | 'door-open' | 'spa';
  /** Richiede PIN prima dell'esecuzione (es. "Esci"). */
  protected: boolean;
  steps: readonly ScenarioStep[];
}
