/**
 * Modello dati interno unificato.
 *
 * Qualunque sia il firmware a bordo (Zigbee2MQTT, Shelly Gen2, Tasmota o JSON
 * custom), l'interfaccia utente lavora *solo* con queste entità normalizzate.
 * La traduzione da/verso i topic MQTT vive esclusivamente in `src/mqtt/adapters`.
 */

export type RoomId = 'living' | 'kitchen' | 'bedroom' | 'study' | 'bath' | 'outdoor';

export type DeviceKind = 'light' | 'climate' | 'power' | 'media' | 'sensor';

/** Identificativo dell'adapter di parsing/encoding associato al device. */
export type AdapterId = 'zigbee2mqtt' | 'shelly' | 'tasmota' | 'custom-json';

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
  | 'smoke';

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
