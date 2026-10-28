/**
 * Modello dati interno unificato.
 *
 * Qualunque sia il firmware a bordo (Zigbee2MQTT, Shelly Gen2, Tasmota o JSON
 * custom), l'interfaccia utente lavora *solo* con queste entità normalizzate.
 * La traduzione da/verso i topic MQTT vive esclusivamente in `src/mqtt/adapters`.
 */

import type { DevicePinPosition } from './floorplan';

/**
 * Le stanze non sono un'unione chiusa: arrivano dal database (`/api/topology`)
 * e la discovery Home Assistant può crearne di nuove a runtime, estendendo la
 * topologia in cache (TanStack Query). Non vivono in `homeStore`.
 */
export type RoomId = string;

export type DeviceKind = 'light' | 'climate' | 'power' | 'media' | 'sensor' | 'camera';

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

export type DeviceAvailability = 'online' | 'offline' | 'stale' | 'unknown';

export type ClimateMode = 'off' | 'heat' | 'cool' | 'auto' | 'fan_only' | 'dry';
export type ClimateAction = 'idle' | 'heating' | 'cooling' | 'drying' | 'fan';
export type FanSpeed = 'auto' | 'low' | 'medium' | 'high';
export type CameraProtocol = 'webrtc' | 'hls' | 'mjpeg' | 'auto';
export type CameraAspectRatio = '16:9' | '4:3';

/**
 * Configurazione del flusso video di una telecamera IP.
 *
 * `url` è l'endpoint raggiungibile dal browser: WHEP/WebRTC (es. go2rtc),
 * playlist HLS o stream MJPEG. L'URL RTSP nudo non è utilizzabile dal client
 * e deve essere esposto da un proxy locale (go2rtc, MediaMTX, ...).
 */
export interface CameraStream {
  url: string;
  snapshotUrl?: string;
  protocol: CameraProtocol;
  aspectRatio: CameraAspectRatio;
}

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

/** Topic MQTT dichiarati nella tabella `devices`. */
export interface DeviceTopics {
  /** Topic di stato sottoscritto in lettura. */
  state: string;
  /** Topic di comando su cui pubblicare (assente sui sensori read-only). */
  command?: string;
  /**
   * Topic LWT/availability opzionale. Il payload è interpretato da
   * `parseAvailabilityPayload`: stringhe semplici, `true/false/0/1` e JSON
   * `{"state":"online"}` (Zigbee2MQTT) sono tutti accettati.
   */
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
  /**
   * Payload LWT che dichiara il device in linea (default: online/true/1/on).
   * Utile per Tasmota (`Online`) e Shelly Gen1 (`true`).
   */
  availabilityPayloadOnline?: string;
  /** Payload LWT che dichiara il device caduto (default: offline/false/0/off). */
  availabilityPayloadOffline?: string;
  /**
   * Silenzio massimo per i sensori passivi prima di considerarli `stale`
   * (es. 1_800_000 = 30 minuti per un sensore a batteria). Se assente, il
   * watchdog applica 30 minuti ai soli sensori senza LWT.
   */
  staleTimeoutMs?: number;
  /**
   * Solo view-model: `false` quando LWT o watchdog dichiarano il device non
   * raggiungibile. Lo calcola il client, quindi non arriva mai dal server.
   */
  isAvailable?: boolean;
  favorite: boolean;
  /** Se true, i comandi richiedono PIN (tapparelle cancello, allarme, ...). */
  protected: boolean;
  /** Ordinamento nella UI, gestito dall'amministrazione. */
  displayOrder?: number;
  /**
   * Marker nella planimetria della stanza (percentuale, 0-100). Assente nei
   * device storici o scoperti: la UI usa il centro della stanza.
   */
  roomPinPosition?: DevicePinPosition;
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

/** Stato logico della telecamera; il player misura lo stato reale della sessione. */
export interface CameraState {
  live: boolean;
}

export interface CameraDevice extends DeviceBase {
  kind: 'camera';
  state: CameraState;
  stream: CameraStream;
}

export type Device =
  | LightDevice
  | ClimateDevice
  | PowerDevice
  | MediaDevice
  | SensorDevice
  | CameraDevice;

export type AnyDeviceState = Device['state'];

/**
 * Omit distributivo: `Omit<union, K>` collasserebbe l'union in un unico tipo
 * con le sole chiavi comuni, perdendo la discriminazione su `kind`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Topologia strutturale: ciò che arriva dal database e cambia solo tramite
 * configurazione. `state`, `availability` e `lastSeen` sono esclusi perché
 * vengono aggiornati dal broker (Zustand) e non devono invalidare la cache.
 * `favorite` resta qui: è una preferenza persistita, non telemetria.
 */
export type DeviceMetadata = DistributiveOmit<
  Device,
  'state' | 'availability' | 'lastSeen'
>;

/** Campi runtime condivisi da ogni tipo di device. */
export interface DeviceRealtimeBase {
  id: string;
  availability: DeviceAvailability;
  lastSeen: number | null;
  /** Override locale del preferito: il valore del server resta nei metadati. */
  favorite: boolean;
  /** true quando l'ultima patch è un'intenzione locale in attesa del broker. */
  isOptimistic: boolean;
  /** Epoch ms dell'ultima scrittura nella mappa realtime. */
  lastUpdated: number;
  /**
   * Disponibilità reale del device: `false` dopo un LWT offline o quando il
   * watchdog dei sensori passivi supera `staleTimeoutMs`. È la sola cosa che
   * le card devono guardare per bloccare i controlli.
   */
  isAvailable: boolean;
}

/**
 * Telemetria volatile indicizzata per id: unica cosa che vive in homeStore.
 * Il discriminante `kind` replica quello dei metadati per validare le patch
 * decodificate senza dover consultare la cache della topologia.
 */
export type DeviceRealtimeState =
  | (DeviceRealtimeBase & { kind: 'light'; state: LightState })
  | (DeviceRealtimeBase & { kind: 'climate'; state: ClimateState })
  | (DeviceRealtimeBase & { kind: 'power'; state: PowerState })
  | (DeviceRealtimeBase & { kind: 'media'; state: MediaState })
  | (DeviceRealtimeBase & { kind: 'sensor'; state: SensorState })
  | (DeviceRealtimeBase & { kind: 'camera'; state: CameraState });

export type DeviceState = DeviceRealtimeState['state'];

/** Patch parziale della riga realtime (mai di soli metadati). */
export type DeviceRealtimePatch = Partial<Omit<DeviceRealtimeBase, 'id' | 'lastUpdated'>> & {
  state?: DeviceState;
};

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
  | { kind: 'sensor'; state: Partial<SensorState> }
  | { kind: 'camera'; state: Partial<CameraState> };

export interface EncodedCommand {
  topic: string;
  payload: string;
  qos: 0 | 1;
  retain?: boolean;
}

/** Slug dello scenario: arriva dal database, non da un'unione compilata. */
export type ScenarioId = string;

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
  /** Nome icona Lucide (stringa: il catalogo scenari vive nel DB). */
  icon: string;
  /** Richiede PIN prima dell'esecuzione (es. "Esci"). */
  protected: boolean;
  steps: readonly ScenarioStep[];
  /** Ordinamento nella overview, gestito dall'amministrazione. */
  displayOrder?: number;
}
