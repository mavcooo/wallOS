import type { BrokerSettings, MqttProtocol } from '@/types/mqtt';
import type { TelemetrySettings } from '@/types/telemetry';
import type { TopologySyncSettings } from '@/types/topologySync';

function randomClientId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `domus-kiosk-${suffix}`;
}

function envText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envPort(value: string | undefined): number | undefined {
  const port = Number(envText(value));
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

function envProtocol(value: string | undefined): MqttProtocol | undefined {
  const protocol = envText(value)?.toLowerCase();
  return protocol === 'ws' || protocol === 'wss' ? protocol : undefined;
}

/**
 * Sottoinsieme pubblico di `import.meta.env` che configura il broker.
 *
 * Solo `VITE_*`: host, porta, path e base topic sono informazione pubblica.
 * Le credenziali non compaiono qui di proposito — arrivano a runtime da
 * Impostazioni → broker (persistite sul singolo pannello) e sono vincolate
 * dalle ACL dell'utenza `wallos_kiosk`.
 */
export interface BrokerEnv {
  VITE_MQTT_HOST?: string;
  VITE_MQTT_PORT?: string;
  VITE_MQTT_PROTOCOL?: string;
  VITE_MQTT_PATH?: string;
  VITE_MQTT_BASE_TOPIC?: string;
}

export type BrokerDefaults = Pick<
  BrokerSettings,
  'host' | 'port' | 'protocol' | 'path' | 'username' | 'password' | 'baseTopic' | 'demoMode'
>;

/**
 * Host del pannello: quello da cui il browser ha caricato la dashboard.
 *
 * Senza `VITE_MQTT_HOST` il broker si presume sulla stessa macchina del pannello:
 * su un tablet in LAN `http://192.168.0.101:3000` significa `192.168.0.101`,
 * non `localhost` (che punterebbe al tablet stesso) e nessun IP cablato.
 * Nei test e negli script senza `window` resta `localhost`.
 */
export function panelHostname(): string {
  if (typeof window === 'undefined') return 'localhost';
  const host = window.location?.hostname;
  return host && host.length > 0 ? host : 'localhost';
}

/**
 * Default pubblici del broker, letti alla build (`VITE_*`). Un valore
 * malformato viene ignorato: resta il default scritto qui sotto.
 *
 * Questi sono solo *default*: le Impostazioni salvate nel persist del browser
 * hanno la precedenza (vedi `merge` del persist in `homeStore`), quindi il
 * pannello può sempre correggere quanto arriva dall'ambiente.
 */
export function resolveBrokerDefaults(env: BrokerEnv): BrokerDefaults {
  const host = envText(env.VITE_MQTT_HOST);
  const port = envPort(env.VITE_MQTT_PORT);
  const protocol = envProtocol(env.VITE_MQTT_PROTOCOL);
  const path = envText(env.VITE_MQTT_PATH);
  const baseTopic = envText(env.VITE_MQTT_BASE_TOPIC);

  // Un ambiente che punta a un broker reale non deve restare in demo. Le
  // credenziali non contano: le imposta l'amministratore sul pannello.
  const configured = [host, port, protocol, path, baseTopic].some(
    (value) => value !== undefined,
  );

  return {
    host: host ?? panelHostname(),
    port: port ?? 9001,
    protocol: protocol ?? 'ws',
    path: path ?? '/mqtt',
    // Mai da ambiente: un segreto nell'ambiente di build finirebbe in `dist/`.
    username: '',
    password: '',
    baseTopic: baseTopic ?? '',
    demoMode: !configured,
  };
}

export const DEFAULT_BROKER: BrokerSettings = {
  ...resolveBrokerDefaults({
    VITE_MQTT_HOST: import.meta.env.VITE_MQTT_HOST,
    VITE_MQTT_PORT: import.meta.env.VITE_MQTT_PORT,
    VITE_MQTT_PROTOCOL: import.meta.env.VITE_MQTT_PROTOCOL,
    VITE_MQTT_PATH: import.meta.env.VITE_MQTT_PATH,
    VITE_MQTT_BASE_TOPIC: import.meta.env.VITE_MQTT_BASE_TOPIC,
  }),
  clientId: randomClientId(),
  keepAlive: 30,
  cleanSession: true,
};

/**
 * Protezione burn-in per pannelli OLED/AMOLED/LCD accesi 24/7.
 * Il movimento usa solo `transform` (composited), mai `top`/`left`.
 */
export const BURN_IN_DEFAULTS = {
  mode: 'screensaver-float' as const,
  /** Ogni quanto si sposta l'orologio/la UI: lento, per non distrarre. */
  shiftIntervalMs: 60_000,
  /** Ampiezza massima dei micro-spostamenti della dashboard (1-4 px). */
  subtleShiftPx: 3,
  /** Durata della transizione fra due posizioni. */
  transitionMs: 1_500,
  /** Opacità dell'orologio in standby: bassa, ma leggibile. */
  dimClockOpacity: 0.3,
  /** Margine di sicurezza dai bordi dello schermo. */
  safeMarginPx: 32,
} as const;

/** Polling del gateway/DB: la UI avvisa quando il database smette di rispondere. */
export const HEALTH_MONITOR = {
  intervalMs: 30_000,
  timeoutMs: 8_000,
} as const;

/**
 * Battery Guardian e salute del display a parete.
 *
 * Il tablet resta alimentato H24: la batteria degli ioni di litio va tenuta
 * nella fascia 20-80% (fuori banda si degrada e può gonfiarsi) e il browser,
 * dopo settimane di esecuzione continua, va sorvegliato su heap e frame rate.
 * Queste soglie sono condivise da monitor, telemetria MQTT e pannello
 * diagnostico.
 */
export const BATTERY_GUARDIAN = {
  /** Fascia di protezione: la presa smart stacca all'80% e riattiva al 20%. */
  protectMinPercent: 20,
  protectMaxPercent: 80,
  /**
   * Pubblicazione periodica della telemetria batteria: gli eventi non
   * arrivano se il browser ha perso il focus per ore, il retained deve
   * restare fresco per la presa smart.
   */
  publishIntervalMs: 60_000,
  /** Campionamento di heap, frame rate e latenza nel pannello diagnostico. */
  sampleIntervalMs: 30_000,
  /** Durata della misura del frame rate: breve, per non pesare sul loop di render. */
  fpsWindowMs: 1_000,
  /** Sotto questo frame rate il pannello è "lento" (diagnostica). */
  minHealthyFps: 24,
  /** Oltre questa quota di heap scatta l'avviso (0,85 = 85% del limite). */
  heapWarnRatio: 0.85,
  /** Un solo toast per finestra: un heap saturo non deve generare raffiche. */
  heapAlertCooldownMs: 10 * 60_000,
  /** Il frame rate basso è un dato diagnostico, non un allarme da toast. */
  fpsLogCooldownMs: 5 * 60_000,
} as const;

/**
 * Heartbeat applicativo MQTT e watchdog anti-freeze.
 *
 * Un socket "half-open" (AP o broker che azzera la sessione TCP senza FIN/RST)
 * lascia mqtt.js con `connected === true` ma muto: queste soglie sono l'unica
 * difesa a livello applicativo.
 */
export const MQTT_WATCHDOG = {
  /** Pubblicazione del ping heartbeat sul topic loopback/pong. */
  heartbeatIntervalMs: 30_000,
  /** Topic di ping (loopback per RTT, pong per un eventuale echo esterno). */
  heartbeatTopic: 'wallos/heartbeat/ping',
  pongTopic: 'wallos/heartbeat/pong',
  /** Silenzio massimo prima di dichiarare la socket zombie. */
  freezeTimeoutMs: 90_000,
  /** Frequenza del controllo di silenzio. */
  checkIntervalMs: 10_000,
  /** Blackout continuo dopo cui si prepara il riavvio. */
  blackoutTimeoutMs: 600_000,
  /** Countdown mostrato prima di `window.location.reload()`. */
  reloadCountdownMs: 30_000,
} as const;

export const KIOSK_DEFAULTS = {
  /** 2 minuti di inattività prima del dim. */
  dimmerTimeoutMs: 120_000,
  /** Fade verso l'overlay nero. */
  dimmerFadeMs: 900,
  /** Tocco "a vuoto" dopo il risveglio, per evitare comandi accidentali. */
  wakeGuardMs: 350,
  /** Luminosità residua dell'orologio in sleep. */
  sleepClockOpacity: 0.14,
  /** Orologio header sempre in formato 24h con secondi. */
  clock24h: true,
} as const;

/**
 * Home Assistant MQTT Discovery: prefissi ascoltati e finestra di debounce.
 * Il prefisso standard è `homeassistant`; installazioni che annunciano altrove
 * (es. `zigbee2mqtt`) si configurano con `VITE_MQTT_DISCOVERY_PREFIXES=a,b`.
 */
const DISCOVERY_PREFIXES = (import.meta.env.VITE_MQTT_DISCOVERY_PREFIXES ?? '')
  .split(',')
  .map((prefix) => prefix.trim())
  .filter((prefix) => prefix.length > 0);

export const DISCOVERY = {
  /** Variabile vuota (come in `.env.example`) = prefisso standard. */
  prefixes: DISCOVERY_PREFIXES.length > 0 ? DISCOVERY_PREFIXES : ['homeassistant'],
  /** All'avvio il broker consegna i retained in raffica: si registra una volta. */
  flushDelayMs: 250,
} as const;

/** Default del buffer telemetria MQTT (modificabili a runtime dallo store). */
export const TELEMETRY_DEFAULTS: TelemetrySettings = {
  throttleMs: 1_000,
  significantDeltaRatio: 0.02,
};

export const TELEMETRY_LIMITS = {
  minThrottleMs: 500,
  maxThrottleMs: 2_000,
} as const;

/**
 * Default della sincronizzazione topologia (modificabili da Impostazioni e
 * persistiti nello store): la finestra in cui gli eventi MQTT/SSE vengono
 * accorpati in un unico refetch della topologia.
 */
export const TOPOLOGY_SYNC_DEFAULTS: TopologySyncSettings = {
  debounceMs: 300,
};

/**
 * Timestamp del boot del client, catturato al primo import della config: è la
 * base per riconoscere i comandi in coda appartenenti a una sessione precedente
 * (blackout elettrico, refresh forzato, crash del browser).
 */
export const APP_BOOT_AT = Date.now();

/**
 * Safe Boot / Power Failure Recovery.
 *
 * Dopo un blackout il pannello e i relè ripartono insieme: finché il broker non
 * ha consegnato i retained, la UI mostra lo stato di sincronizzazione e non
 * manda comandi. La finestra si chiude con il debounce di quiete (nessun
 * retained per `quietWindowMs`), mai prima di `minHydrationMs` e comunque entro
 * `maxHydrationMs`.
 */
export const BOOT_RECOVERY = {
  /** Silenzio dopo l'ultimo retained che dichiara la casa idratata. */
  quietWindowMs: 2_000,
  /** Pavimento: evita un flash "sincronizzato" su un broker già in silenzio. */
  minHydrationMs: 3_000,
  /** Tetto: la UI si sblocca comunque, anche con broker muto o assente. */
  maxHydrationMs: 12_000,
  /** Anzianità massima di un comando ripreso dallo storage: oltre, si scarta. */
  maxCommandTtlMs: 5 * 60_000,
} as const;

/** Parametri della coda comandi offline (QoS, TTL, retry, flush). */
export const OFFLINE_QUEUE = {
  /** Ogni quanto la coda scarta i comandi scaduti anche senza riconnessione. */
  sweepIntervalMs: 1_000,
  /**
   * Limite fisso della coda: oltre, i comandi più vecchi escono in FIFO.
   * Tiene costante la pressione su `localStorage` durante un offline lungo.
   */
  maxQueueSize: 25,
  /** Pausa tra due publish consecutivi durante il flush FIFO (30–100 ms). */
  flushGapMs: 50,
  /** Tentativi di pubblicazione oltre il primo prima del rollback definitivo. */
  maxRetries: 2,
  /** Attesa massima della conferma broker (PUBACK) per un comando QoS 1. */
  ackTimeoutMs: 6_000,
  retryBaseMs: 500,
  retryMaxMs: 8_000,
  /** TTL dei valori continui (slider): dopo pochi minuti non hanno più senso. */
  transientTtlMs: 2 * 60_000,
  /** TTL dei comandi discreti (on/off, modalità, sorgente). */
  standardTtlMs: 10 * 60_000,
} as const;

