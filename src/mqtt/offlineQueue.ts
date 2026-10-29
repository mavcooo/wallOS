import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';

import { APP_BOOT_AT, BOOT_RECOVERY, OFFLINE_QUEUE } from '@/config/app.config';
import i18n from '@/i18n';
import { randomId } from '@/lib/randomId';
import { rollbackState } from '@/mqtt/optimistic';
import { logRecovery } from '@/mqtt/recoveryLog';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type { ControlAction, DecodedState } from '@/types/device';

/** Limite fisso della coda: oltre, i comandi più vecchi escono in FIFO. */
export const MAX_QUEUE_SIZE = OFFLINE_QUEUE.maxQueueSize;
/** Finestra ammessa per la pausa tra due publish del flush. */
const FLUSH_GAP_MIN_MS = 30;
const FLUSH_GAP_MAX_MS = 100;
const LOG_PREFIX = '[OfflineQueue]';

/**
 * Coda comandi offline con QoS, TTL, collasso, limite FIFO e rollback
 * ottimistico.
 *
 * Un comando resta in coda finché il broker non lo conferma (PUBACK sui QoS 1).
 * Se la connessione cade il flush si ferma e riparte al reconnect; se il TTL
 * scade o il publish fallisce in modo definitivo, la patch ottimistica viene
 * annullata nello store e l'utente riceve un toast.
 *
 * La coda è **bounded** (`MAX_QUEUE_SIZE`) e collassa per device/campo: un
 * tablet offline per ore non accumula né comandi intermedi né scritture
 * illimitate in `localStorage`.
 */
export interface QueuedCommand {
  /** UUID del comando: resta stabile anche quando il payload viene collassato. */
  id: string;
  deviceId: string;
  /** Nome leggibile, per i toast che sopravvivono a un refresh. */
  deviceName: string;
  /** Topic locale (senza `baseTopic`): il prefisso viene applicato al publish. */
  topic: string;
  payload: string;
  /** Epoch ms dell'ultima intenzione dell'utente (base per il TTL). */
  timestamp: number;
  qos: 0 | 1;
  /** Validità massima del comando in coda. */
  timeoutMs: number;
  retryCount: number;
  retain: boolean;
  /** Chiave di collasso: stesso device + stessa chiave = ultimo valore vince. */
  collapseKey: string;
  /** Descrizione leggibile dell'azione (es. "Luminosità 40%"). */
  label: string;
  /** Patch applicata alla UI in attesa di conferma. */
  optimistic: DecodedState | null;
  /** Stato precedente dei soli campi toccati da `optimistic`. */
  rollback: DecodedState | null;
  /** Incrementata a ogni collasso: invalida gli ACK della versione precedente. */
  revision: number;
}

export interface EnqueueCommandInput {
  deviceId: string;
  deviceName: string;
  topic: string;
  payload: string;
  qos: 0 | 1;
  retain?: boolean;
  timeoutMs: number;
  /** Chiave di collasso; se omessa coincide con il topic del comando. */
  collapseKey?: string;
  label: string;
  optimistic: DecodedState | null;
  rollback: DecodedState | null;
}

export interface OfflineQueueState {
  /** Ordinata FIFO: l'indice 0 è il prossimo comando da inviare. */
  commands: QueuedCommand[];
  enqueue(input: EnqueueCommandInput): QueuedCommand;
  /** Rimuove solo se la revisione coincide (un comando collassato resta in coda). */
  remove(id: string, revision?: number): boolean;
  markRetry(id: string, revision: number): void;
  /** Svuota la coda e la copia persistita (cambio casa, logout, reset). */
  clear(): void;
}

/** Ciò che serve alla coda per pubblicare: fornito da `useMqtt` per ogni socket. */
export interface QueueRuntime {
  isConnected(): boolean;
  publish(command: QueuedCommand): Promise<boolean>;
}

export interface FlushResult {
  sent: number;
  expired: number;
  failed: number;
}

type PersistedQueue = Pick<OfflineQueueState, 'commands'>;

/** Tronca FIFO la coda al limite: i comandi più vecchi escono per primi. */
function boundQueue(commands: QueuedCommand[]): QueuedCommand[] {
  if (commands.length <= MAX_QUEUE_SIZE) return commands;
  const overflow = commands.length - MAX_QUEUE_SIZE;
  console.warn(`${LOG_PREFIX} Coda satura: eliminato comando obsoleto (${overflow})`);
  return commands.slice(overflow);
}

/**
 * Storage della coda: ogni accesso a `localStorage` è protetto.
 *
 * In navigazione privata o a quota esaurita `setItem` lancia
 * `QuotaExceededError`: la coda continua a vivere in memoria e, prima di
 * rinunciare alla persistenza, salva i soli comandi più recenti.
 */
const queueStorage: PersistStorage<PersistedQueue> = {
  getItem(name) {
    try {
      const raw = window.localStorage.getItem(name);
      if (!raw) return null;
      return JSON.parse(raw) as StorageValue<PersistedQueue>;
    } catch {
      // Storage inibito o JSON corrotto: si riparte da una coda vuota.
      return null;
    }
  },

  setItem(name, value) {
    try {
      window.localStorage.setItem(name, JSON.stringify(value));
      return;
    } catch {
      // Quota esaurita: si tenta con i soli comandi recenti.
    }

    const commands = value.state.commands;
    if (commands.length > 1) {
      try {
        const trimmed: StorageValue<PersistedQueue> = {
          ...value,
          state: {
            commands: commands.slice(-Math.max(1, Math.floor(MAX_QUEUE_SIZE / 2))),
          },
        };
        window.localStorage.setItem(name, JSON.stringify(trimmed));
        console.warn(`${LOG_PREFIX} Quota storage ridotta: persistiti i comandi più recenti`);
        return;
      } catch {
        // Storage inibito del tutto (private mode, permessi negati).
      }
    }
    console.warn(`${LOG_PREFIX} Storage non disponibile: coda mantenuta solo in memoria`);
  },

  removeItem(name) {
    try {
      window.localStorage.removeItem(name);
    } catch {
      // Storage inibito: non c'è nulla da rimuovere.
    }
  },
};

export const useOfflineQueue = create<OfflineQueueState>()(
  persist(
    (set, get) => ({
      commands: [],

      enqueue(input) {
        const now = Date.now();
        const collapseKey = input.collapseKey ?? input.topic;
        const existing = get().commands.find(
          (command) =>
            command.deviceId === input.deviceId && command.collapseKey === collapseKey,
        );

        if (existing) {
          // Lo slider genera N comandi mentre si è offline: ne resta uno solo,
          // nella stessa posizione FIFO, con il rollback del primo valore reale.
          const next: QueuedCommand = {
            ...existing,
            topic: input.topic,
            payload: input.payload,
            qos: input.qos,
            retain: input.retain ?? false,
            timeoutMs: input.timeoutMs,
            timestamp: now,
            retryCount: 0,
            label: input.label,
            optimistic: input.optimistic,
            rollback: existing.rollback ?? input.rollback,
            revision: existing.revision + 1,
          };
          set((state) => ({
            commands: state.commands.map((command) =>
              command.id === existing.id ? next : command,
            ),
          }));
          return next;
        }

        const command: QueuedCommand = {
          id: randomId(),
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          topic: input.topic,
          payload: input.payload,
          qos: input.qos,
          retain: input.retain ?? false,
          timeoutMs: input.timeoutMs,
          timestamp: now,
          retryCount: 0,
          collapseKey,
          label: input.label,
          optimistic: input.optimistic,
          rollback: input.rollback,
          revision: 1,
        };
        // Un comando per un device nuovo può far uscire il più vecchio: la
        // cardinalità resta costante qualunque sia la durata dell'offline.
        set((state) => ({ commands: boundQueue([...state.commands, command]) }));
        return command;
      },

      remove(id, revision) {
        const existing = get().commands.find((command) => command.id === id);
        if (!existing) return false;
        if (revision !== undefined && existing.revision !== revision) return false;
        set((state) => ({
          commands: state.commands.filter((command) => command.id !== id),
        }));
        return true;
      },

      markRetry(id, revision) {
        set((state) => ({
          commands: state.commands.map((command) =>
            command.id === id && command.revision === revision
              ? { ...command, retryCount: command.retryCount + 1 }
              : command,
          ),
        }));
      },

      clear() {
        set({ commands: [] });
      },
    }),
    {
      name: 'wallos_offline_queue',
      version: 1,
      storage: queueStorage,
      partialize: (state): PersistedQueue => ({ commands: state.commands }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<PersistedQueue> | undefined;
        const commands = (saved?.commands ?? []).filter(
          (command): command is QueuedCommand =>
            typeof command?.id === 'string' &&
            typeof command.deviceId === 'string' &&
            typeof command.topic === 'string' &&
            typeof command.payload === 'string' &&
            Number.isFinite(command.timestamp) &&
            (command.qos === 0 || command.qos === 1),
        );
        // Anche uno storage legacy o manomesso non può superare il limite.
        return { ...current, commands: boundQueue(commands) };
      },
    },
  ),
);

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// ── Runtime di pubblicazione (uno solo, installato da `useMqtt`) ────────────
let runtime: QueueRuntime | null = null;
let flushing = false;
let rerunRequested = false;
let retryTimer: number | null = null;
let inFlight: { id: string; revision: number } | null = null;

export function installQueueRuntime(next: QueueRuntime): () => void {
  runtime = next;
  return () => {
    if (runtime === next) runtime = null;
  };
}

function isInFlight(command: QueuedCommand): boolean {
  return inFlight?.id === command.id && inFlight.revision === command.revision;
}

function isExpired(command: QueuedCommand, now: number): boolean {
  return now - command.timestamp >= command.timeoutMs;
}

/** Il broker ha già lo stato richiesto: il comando in coda è ridondante. */
function isFulfilled(command: QueuedCommand, decoded: DecodedState): boolean {
  if (!command.optimistic || command.optimistic.kind !== decoded.kind) return false;
  const expected = command.optimistic.state as Record<string, unknown>;
  const actual = decoded.state as Record<string, unknown>;
  const keys = Object.keys(expected);
  return keys.length > 0 && keys.every((key) => key in actual && actual[key] === expected[key]);
}

function rollbackCommand(command: QueuedCommand, reason: 'expired' | 'failed'): boolean {
  if (!useOfflineQueue.getState().remove(command.id, command.revision)) return false;

  // Rollback sul solo runtime del device: i metadati non servono alla coda.
  const device = useHomeStore.getState().deviceStates[command.deviceId];
  const patch = device
    ? rollbackState(device, command.optimistic, command.rollback)
    : null;
  if (patch) useHomeStore.getState().applyOptimistic(command.deviceId, patch);

  useToastStore.getState().push({
    title: i18n.t(reason === 'expired' ? 'queue.expiredTitle' : 'queue.failedTitle'),
    description: i18n.t(
      reason === 'expired' ? 'queue.expiredDescription' : 'queue.failedDescription',
      { device: command.deviceName, action: command.label },
    ),
    tone: reason === 'expired' ? 'info' : 'error',
  });
  return true;
}

/**
 * Scarta i comandi il cui TTL è terminato e ripristina la UI.
 * Ritorna quanti comandi sono stati rimossi.
 */
export function expireQueuedCommands(now = Date.now()): number {
  let expired = 0;
  for (const command of useOfflineQueue.getState().commands) {
    if (isInFlight(command) || !isExpired(command, now)) continue;
    if (rollbackCommand(command, 'expired')) expired += 1;
  }
  return expired;
}

/**
 * Riconciliazione passiva: se un messaggio `stat` conferma i campi ottimistici
 * di un comando in coda, quel comando non serve più.
 */
export function reconcileQueuedCommands(deviceId: string, decoded: DecodedState): void {
  for (const command of useOfflineQueue.getState().commands) {
    if (command.deviceId !== deviceId || isInFlight(command)) continue;
    if (!isFulfilled(command, decoded)) continue;
    useOfflineQueue.getState().remove(command.id, command.revision);
  }
}

export interface BootPurgeResult {
  /** Comandi rimossi dalla coda: non verranno mai trasmessi. */
  discarded: number;
  /** Nati in una sessione precedente (blackout, refresh, crash). */
  previousSession: number;
  /** Troppo vecchi, anche se dello stesso avvio (orologio sfasato, backup). */
  tooOld: number;
}

/**
 * Safe boot: scarta i comandi rimasti in storage da una sessione precedente.
 *
 * Deve girare **prima** di qualsiasi connessione o flush: un comando nato prima
 * del blackout rappresenta un'intenzione di ore fa, non lo stato attuale dei
 * relè. Oltre al confronto con il timestamp di boot, la soglia `maxCommandTtlMs`
 * copre orologi sfasati e storage ripristinati da un backup.
 */
export function purgeStaleCommandsOnBoot(
  options: { bootedAt?: number; now?: number; maxAgeMs?: number } = {},
): BootPurgeResult {
  const now = options.now ?? Date.now();
  const bootedAt = options.bootedAt ?? APP_BOOT_AT;
  const maxAgeMs = options.maxAgeMs ?? BOOT_RECOVERY.maxCommandTtlMs;

  const commands = useOfflineQueue.getState().commands;
  const result: BootPurgeResult = { discarded: 0, previousSession: 0, tooOld: 0 };
  if (commands.length === 0) return result;

  const kept = commands.filter((command) => {
    if (command.timestamp < bootedAt) {
      result.previousSession += 1;
      return false;
    }
    if (now - command.timestamp > maxAgeMs) {
      result.tooOld += 1;
      return false;
    }
    return true;
  });

  result.discarded = result.previousSession + result.tooOld;
  if (result.discarded === 0) return result;

  useOfflineQueue.setState({ commands: kept });
  // Diagnostica visibile nel pannello, non solo in console.
  const detail = [
    result.previousSession > 0 ? `${result.previousSession} pre-blackout` : null,
    result.tooOld > 0 ? `${result.tooOld} oltre ${Math.round(maxAgeMs / 60_000)} min` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  logRecovery(
    `Scartati ${result.discarded} comandi obsoleti risalenti alla sessione pre-blackout (${detail})`,
  );
  return result;
}

/** Dopo un refresh accidentale riallinea la UI ai comandi ancora in coda. */
export function restorePendingOptimisticState(): void {
  for (const command of useOfflineQueue.getState().commands) {
    if (command.optimistic) {
      useHomeStore.getState().applyOptimistic(command.deviceId, command.optimistic);
    }
  }
}

function scheduleRetry(attempt: number): void {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  const delay = Math.min(
    OFFLINE_QUEUE.retryMaxMs,
    OFFLINE_QUEUE.retryBaseMs * 2 ** Math.max(0, attempt - 1),
  );
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flushOfflineQueue();
  }, delay);
}

/**
 * Flush FIFO dei comandi validi. Si ferma appena la connessione cade,
 * lasciando in coda il comando corrente e i successivi.
 */
export async function flushOfflineQueue(options?: { announce?: boolean }): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, expired: 0, failed: 0 };

  if (flushing) {
    // Una richiesta arrivata durante un flush (es. reconnect) non va persa.
    rerunRequested = true;
    return result;
  }

  // Safe boot: la coda resta in pausa finché la casa non è idratata dai
  // retained. Un comando inviato ora potrebbe invertire lo stato appena
  // ricostruito dai relè dopo un blackout.
  if (useHomeStore.getState().recovery.isHydrating) return result;

  const ctx = runtime;
  if (!ctx || !ctx.isConnected()) return result;

  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }

  flushing = true;
  try {
    for (;;) {
      result.expired += expireQueuedCommands();
      if (!ctx.isConnected()) break;

      const command = useOfflineQueue.getState().commands[0];
      if (!command) break;

      let ok = false;
      inFlight = { id: command.id, revision: command.revision };
      try {
        ok = await ctx.publish(command);
      } catch {
        ok = false;
      } finally {
        inFlight = null;
      }

      if (ok) {
        if (useOfflineQueue.getState().remove(command.id, command.revision)) {
          result.sent += 1;
        }
        if (!ctx.isConnected()) break;
        // Ritmo controllato: una raffica di PUBLISH al reconnect riempie il
        // buffer della WebSocket e fa chiudere la socket da Mosquitto.
        await sleep(
          Math.min(FLUSH_GAP_MAX_MS, Math.max(FLUSH_GAP_MIN_MS, OFFLINE_QUEUE.flushGapMs)),
        );
        continue;
      }

      // Rete caduta durante il publish: il comando resta in coda per il
      // prossimo reconnect, senza consumare un tentativo.
      if (!ctx.isConnected()) break;

      const current = useOfflineQueue
        .getState()
        .commands.find((item) => item.id === command.id);
      if (!current) continue;
      if (current.revision !== command.revision) continue;

      if (current.retryCount >= OFFLINE_QUEUE.maxRetries) {
        if (rollbackCommand(current, 'failed')) result.failed += 1;
        continue;
      }

      useOfflineQueue.getState().markRetry(current.id, current.revision);
      scheduleRetry(current.retryCount + 1);
      break;
    }
  } finally {
    flushing = false;
    if (rerunRequested) {
      rerunRequested = false;
      window.setTimeout(() => {
        void flushOfflineQueue();
      }, 0);
    }
  }

  if (options?.announce && result.sent > 0) {
    useToastStore.getState().push({
      title: 'Comandi sincronizzati',
      description: `${result.sent} ${result.sent === 1 ? 'comando inviato' : 'comandi inviati'} al broker.`,
      tone: 'success',
    });
  }

  return result;
}

// ── Politiche per azione ────────────────────────────────────────────────────

/** I valori continui scadono prima: inviare una luminosità di ore fa è inutile. */
export function commandTimeoutMs(action: ControlAction): number {
  switch (action.type) {
    case 'brightness':
    case 'volume':
    case 'targetTemp':
      return OFFLINE_QUEUE.transientTtlMs;
    default:
      return OFFLINE_QUEUE.standardTtlMs;
  }
}

/**
 * Identifica il campo logico dell'azione: comandi con la stessa chiave sullo
 * stesso device vengono collassati nell'ultimo valore impostato.
 */
export function collapseKeyFor(action: ControlAction): string {
  switch (action.type) {
    case 'power':
      return 'power';
    case 'brightness':
      return 'brightness';
    case 'colorTemp':
      return 'colorTemp';
    case 'targetTemp':
      return 'targetTemp';
    case 'climateMode':
      return 'climateMode';
    case 'fanSpeed':
      return 'fanSpeed';
    case 'swing':
      return 'swing';
    case 'volume':
      return 'volume';
    case 'source':
      return 'source';
  }
}

export function describeAction(action: ControlAction): string {
  // Le etichette sono usate nei toast di rollback: vanno nella lingua attiva
  // al momento dell'invio, non in quella del bundle.
  const t = i18n.getFixedT(null, 'devices');
  switch (action.type) {
    case 'power':
      return t(action.on ? 'actionLabels.powerOn' : 'actionLabels.powerOff');
    case 'brightness':
      return t('actionLabels.brightness', { value: action.brightness });
    case 'colorTemp':
      return t('actionLabels.colorTemp', { value: action.kelvin });
    case 'targetTemp':
      return t('actionLabels.targetTemp', { value: action.targetTemp });
    case 'climateMode':
      return t('actionLabels.climateMode', { mode: action.mode });
    case 'fanSpeed':
      return t('actionLabels.fanSpeed', { speed: action.fanSpeed });
    case 'swing':
      return t('actionLabels.swing', { state: action.swing ? 'on' : 'off' });
    case 'volume':
      return t('actionLabels.volume', { value: action.volume });
    case 'source':
      return t('actionLabels.source', { source: action.source });
  }
}
