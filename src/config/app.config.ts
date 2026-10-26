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

/** Sottoinsieme di `import.meta.env` che configura il broker. */
export interface BrokerEnv {
  MQTT_HOST?: string;
  MQTT_PORT?: string;
  MQTT_PROTOCOL?: string;
  MQTT_PATH?: string;
  MQTT_BASE_TOPIC?: string;
  MQTT_USERNAME?: string;
  MQTT_PASSWORD?: string;
}

export type BrokerDefaults = Pick<
  BrokerSettings,
  'host' | 'port' | 'protocol' | 'path' | 'username' | 'password' | 'baseTopic' | 'demoMode'
>;

/**
 * Default del broker presi dalle variabili d'ambiente lette a startup (`.env`
 * locale, `infisical run` in dev, secret store della piattaforma in build).
 * Un valore malformato viene ignorato: resta il default scritto qui sotto.
 *
 * Questi sono solo *default*: le Impostazioni salvate nel persist del browser
 * hanno la precedenza (vedi `merge` del persist in `homeStore`), quindi il
 * pannello può sempre correggere quanto arriva dall'ambiente.
 */
export function resolveBrokerDefaults(env: BrokerEnv): BrokerDefaults {
  const host = envText(env.MQTT_HOST);
  const port = envPort(env.MQTT_PORT);
  const protocol = envProtocol(env.MQTT_PROTOCOL);
  const path = envText(env.MQTT_PATH);
  const baseTopic = envText(env.MQTT_BASE_TOPIC);
  const username = envText(env.MQTT_USERNAME);
  const password = envText(env.MQTT_PASSWORD);

  // Un ambiente che punta a un broker reale non deve restare in demo.
  const configured = [host, port, protocol, path, baseTopic, username, password].some(
    (value) => value !== undefined,
  );

  return {
    host: host ?? '192.168.1.10',
    port: port ?? 9001,
    protocol: protocol ?? 'ws',
    path: path ?? '/mqtt',
    username: username ?? '',
    password: password ?? '',
    baseTopic: baseTopic ?? '',
    demoMode: !configured,
  };
}

export const DEFAULT_BROKER: BrokerSettings = {
  ...resolveBrokerDefaults(import.meta.env),
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
 * (es. `zigbee2mqtt`) si configurano con `MQTT_DISCOVERY_PREFIXES=a,b`.
 */
const DISCOVERY_PREFIXES = (import.meta.env.MQTT_DISCOVERY_PREFIXES ?? '')
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
  /** Pausa tra due publish consecutivi durante il flush FIFO. */
  flushGapMs: 40,
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

