import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_BROKER, KIOSK_DEFAULTS } from '@/config/app.config';
import { normalizeBurnInSettings } from '@/lib/burnIn';
import { mergeDecodedRealtime, seedDeviceRealtimeState } from '@/lib/deviceState';
import { normalizeTelemetrySettings } from '@/lib/telemetry';
import type { BurnInSettings } from '@/types/kiosk';
import type {
  DecodedState,
  Device,
  DeviceAvailability,
  DeviceRealtimePatch,
  DeviceRealtimeState,
  RoomId,
} from '@/types/device';
import type { BrokerSettings, ConnectionMetrics, ConnectionStatus } from '@/types/mqtt';
import type { RawMqttMessage } from '@/types/mqtt';
import type { TelemetrySettings, TelemetryUpdate } from '@/types/telemetry';

export type ViewId = 'overview' | 'rooms' | 'energy' | 'settings' | 'users' | 'admin';

export interface UiState {
  view: ViewId;
  room: RoomId;
  dimmerTimeoutMs: number;
  screenDimmed: boolean;
  lastActionAt: number;
}

/** Mappa indicizzata: letture e patch di un device costano O(1). */
type DeviceStateMap = Record<string, DeviceRealtimeState>;

/**
 * Stato client effimero. La topologia (stanze, anagrafica device, scenari) vive
 * in TanStack Query; qui restano solo telemetria, connessione, log e
 * preferenze. In questo modo un payload MQTT non può invalidare i metadati.
 */
export interface HomeState {
  // ── Telemetria volatile ──────────────────────────────────────────────────
  deviceStates: DeviceStateMap;
  /**
   * Allinea la mappa ai metadati ricevuti: crea le righe mancanti dallo
   * snapshot del server, conserva quelle esistenti, elimina i device spariti.
   * Va chiamata al bootstrap e a ogni refetch/discovery, non a ogni messaggio.
   */
  syncDeviceStates(seeds: readonly Device[]): void;
  /** Patch O(1) di una singola riga (availability, favorite, flag ottimistici). */
  updateDeviceState(id: string, patch: DeviceRealtimePatch): void;
  /** Inserimento/aggiornamento massivo: una sola `set` per l'intero batch. */
  setBulkDeviceStates(states: DeviceStateMap): void;
  /** Percorso critico: applica subito la patch (on/off, mode, allarmi, comandi). */
  applyDecoded(deviceId: string, decoded: DecodedState): void;
  /**
   * Patch di riconciliazione (ottimistica, replay dopo refresh, rollback):
   * aggiorna lo stato senza dichiarare il device online né toccare `lastSeen`.
   */
  applyOptimistic(deviceId: string, decoded: DecodedState): void;
  /** Percorso telemetria: applica più device in un'unica transazione Zustand. */
  applyTelemetryBatch(updates: readonly TelemetryUpdate[]): void;
  setAvailability(deviceId: string, availability: DeviceAvailability): void;
  toggleFavorite(deviceId: string): void;
  /** Tick del simulatore locale (solo modalità demo). */
  simulateTelemetry(): void;

  // ── Connessione ──────────────────────────────────────────────────────────
  connection: ConnectionMetrics;
  patchConnection(patch: Partial<ConnectionMetrics>): void;
  setStatus(status: ConnectionStatus): void;
  countMessage(direction: 'in' | 'out'): void;

  // ── Log RAW (Test Topic) ─────────────────────────────────────────────────
  rawLog: RawMqttMessage[];
  appendRaw(message: RawMqttMessage): void;
  clearRaw(): void;

  // ── Preferenze / configurazione ──────────────────────────────────────────
  broker: BrokerSettings;
  updateBroker(patch: Partial<BrokerSettings>): void;
  /** Finestra di throttle e soglia di variazione significativa. */
  telemetry: TelemetrySettings;
  setTelemetrySettings(patch: Partial<TelemetrySettings>): void;
  /** Protezione burn-in: strategia, intervallo e opacità dell'orologio. */
  burnIn: BurnInSettings;
  setBurnInSettings(patch: Partial<BurnInSettings>): void;
  ui: UiState;
  setView(view: ViewId): void;
  setRoom(room: RoomId): void;
  setDimmerTimeout(ms: number): void;
  setScreenDimmed(dimmed: boolean): void;
  touchActivity(): void;
}

const initialConnection: ConnectionMetrics = {
  status: 'idle',
  latencyMs: null,
  reconnectAttempts: 0,
  connectedAt: null,
  lastError: null,
  messagesIn: 0,
  messagesOut: 0,
};

const initialUi: UiState = {
  view: 'overview',
  room: 'living',
  dimmerTimeoutMs: KIOSK_DEFAULTS.dimmerTimeoutMs,
  screenDimmed: false,
  lastActionAt: Date.now(),
};

/**
 * Applica una patch decodificata alla riga del device.
 * `optimistic` distingue l'intenzione locale dalla telemetria del broker.
 */
function mergeRow(
  current: DeviceRealtimeState | undefined,
  decoded: DecodedState,
  optimistic: boolean,
): DeviceRealtimeState | null {
  if (!current || current.kind !== decoded.kind) return null;
  return {
    ...current,
    state: { ...current.state, ...decoded.state },
    isOptimistic: optimistic,
    lastUpdated: Date.now(),
  } as DeviceRealtimeState;
}

function jitter(value: number, amplitude: number, min: number): number {
  return Math.max(min, value + (Math.random() - 0.5) * amplitude);
}

type PersistedHome = Pick<HomeState, 'broker' | 'ui' | 'telemetry' | 'burnIn'>;

export const useHomeStore = create<HomeState>()(
  persist(
    (set, get) => ({
      deviceStates: {},

      syncDeviceStates(seeds) {
        set((state) => {
          const next: DeviceStateMap = {};
          for (const seed of seeds) {
            const existing = state.deviceStates[seed.id];
            next[seed.id] =
              existing && existing.kind === seed.kind
                ? existing
                : seedDeviceRealtimeState(seed);
          }

          const nextIds = Object.keys(next);
          const sameSize = nextIds.length === Object.keys(state.deviceStates).length;
          if (sameSize && nextIds.every((id) => next[id] === state.deviceStates[id])) {
            return state;
          }
          return { deviceStates: next };
        });
      },

      updateDeviceState(id, patch) {
        set((state) => {
          const current = state.deviceStates[id];
          if (!current) return state;
          return {
            deviceStates: {
              ...state.deviceStates,
              [id]: {
                ...current,
                ...patch,
                lastUpdated: Date.now(),
              } as DeviceRealtimeState,
            },
          };
        });
      },

      setBulkDeviceStates(states) {
        const entries = Object.keys(states);
        if (entries.length === 0) return;
        set((state) => ({
          deviceStates: { ...state.deviceStates, ...states },
        }));
      },

      applyDecoded(deviceId, decoded) {
        set((state) => {
          const next = mergeRow(state.deviceStates[deviceId], decoded, false);
          if (!next) return state;
          return {
            deviceStates: {
              ...state.deviceStates,
              [deviceId]: {
                ...next,
                availability: 'online',
                lastSeen: Date.now(),
              },
            },
          };
        });
      },

      applyOptimistic(deviceId, decoded) {
        set((state) => {
          const next = mergeRow(state.deviceStates[deviceId], decoded, true);
          if (!next) return state;
          return {
            deviceStates: { ...state.deviceStates, [deviceId]: next },
          };
        });
      },

      applyTelemetryBatch(updates) {
        if (updates.length === 0) return;
        set((state) => {
          // Una sola copia della mappa e una sola `set` per l'intero batch:
          // i device non toccati conservano lo stesso riferimento in memoria.
          const deviceStates: DeviceStateMap = { ...state.deviceStates };
          let changed = false;
          for (const update of updates) {
            const current = deviceStates[update.deviceId];
            const merged = mergeDecodedRealtime(current, update.decoded);
            if (!merged || !current) continue;
            deviceStates[update.deviceId] = {
              ...merged,
              // Timestamp di arrivo, mai regressioni anche con flush fuori ordine.
              lastSeen: Math.max(current.lastSeen ?? 0, update.at),
            };
            changed = true;
          }
          return changed ? { deviceStates } : state;
        });
      },

      setAvailability(deviceId, availability) {
        set((state) => {
          const current = state.deviceStates[deviceId];
          if (!current) return state;
          return {
            deviceStates: {
              ...state.deviceStates,
              [deviceId]: { ...current, availability, lastUpdated: Date.now() },
            },
          };
        });
      },

      toggleFavorite(deviceId) {
        set((state) => {
          const current = state.deviceStates[deviceId];
          if (!current) return state;
          return {
            deviceStates: {
              ...state.deviceStates,
              [deviceId]: {
                ...current,
                favorite: !current.favorite,
                lastUpdated: Date.now(),
              },
            },
          };
        });
      },

      simulateTelemetry() {
        set((state) => {
          const now = Date.now();
          const deviceStates: DeviceStateMap = { ...state.deviceStates };
          for (const [id, row] of Object.entries(state.deviceStates)) {
            if (row.kind === 'power') {
              const base = row.state.on ? Math.max(5, row.state.watts) : 0;
              const watts = Math.round(jitter(base, row.state.on ? 40 : 0, 0));
              deviceStates[id] = {
                ...row,
                lastUpdated: now,
                lastSeen: now,
                state: {
                  ...row.state,
                  watts,
                  voltage: Math.round(jitter(230, 4, 215)),
                  current: Number((watts / 230).toFixed(2)),
                  energyTodayKwh: Number(
                    (row.state.energyTodayKwh + (watts / 3_600_000) * 3).toFixed(3),
                  ),
                  energyTotalKwh: Number(
                    (row.state.energyTotalKwh + (watts / 3_600_000) * 3).toFixed(3),
                  ),
                },
              };
            } else if (row.kind === 'climate') {
              const climate = row.state;
              const active = climate.mode !== 'off';
              const delta = active ? climate.targetTemp - climate.currentTemp : 0;
              const currentTemp = Number(
                (climate.currentTemp + Math.max(-0.1, Math.min(0.1, delta * 0.05))).toFixed(1),
              );
              deviceStates[id] = {
                ...row,
                lastUpdated: now,
                lastSeen: now,
                state: {
                  ...climate,
                  currentTemp,
                  humidity:
                    climate.humidity === undefined
                      ? undefined
                      : Math.round(jitter(climate.humidity, 1.4, 25)),
                  action: active
                    ? delta > 0.2
                      ? 'heating'
                      : delta < -0.2
                        ? 'cooling'
                        : 'idle'
                    : 'idle',
                },
              };
            } else if (row.kind === 'sensor' && typeof row.state.value === 'number') {
              const amp = row.state.type === 'co2' ? 30 : 0.4;
              deviceStates[id] = {
                ...row,
                lastUpdated: now,
                lastSeen: now,
                state: {
                  ...row.state,
                  value: Number(jitter(row.state.value, amp, 0).toFixed(1)),
                },
              };
            }
          }
          return { deviceStates };
        });

        // Le metriche di connessione in demo restano realistiche ma stabili.
        const latency = get().connection.latencyMs;
        set((state) => ({
          connection: {
            ...state.connection,
            latencyMs:
              latency === null
                ? 8
                : Math.max(3, Math.round(jitter(latency, 4, 2))),
          },
        }));
      },

      connection: initialConnection,
      patchConnection(patch) {
        set((state) => ({ connection: { ...state.connection, ...patch } }));
      },
      setStatus(status) {
        set((state) => ({
          connection: { ...state.connection, status },
        }));
      },
      countMessage(direction) {
        set((state) => ({
          connection: {
            ...state.connection,
            messagesIn:
              direction === 'in'
                ? state.connection.messagesIn + 1
                : state.connection.messagesIn,
            messagesOut:
              direction === 'out'
                ? state.connection.messagesOut + 1
                : state.connection.messagesOut,
          },
        }));
      },

      rawLog: [],
      appendRaw(message) {
        set((state) => ({
          rawLog: [message, ...state.rawLog].slice(0, 200),
        }));
      },
      clearRaw() {
        set({ rawLog: [] });
      },

      broker: DEFAULT_BROKER,
      updateBroker(patch) {
        set((state) => ({ broker: { ...state.broker, ...patch } }));
      },

      telemetry: normalizeTelemetrySettings(),
      setTelemetrySettings(patch) {
        set((state) => ({
          telemetry: normalizeTelemetrySettings({ ...state.telemetry, ...patch }),
        }));
      },

      burnIn: normalizeBurnInSettings(),
      setBurnInSettings(patch) {
        set((state) => ({
          burnIn: normalizeBurnInSettings({ ...state.burnIn, ...patch }),
        }));
      },

      ui: initialUi,
      setView(view) {
        set((state) => ({ ui: { ...state.ui, view, lastActionAt: Date.now() } }));
      },
      setRoom(room) {
        set((state) => ({ ui: { ...state.ui, room, lastActionAt: Date.now() } }));
      },
      setDimmerTimeout(ms) {
        set((state) => ({ ui: { ...state.ui, dimmerTimeoutMs: ms } }));
      },
      setScreenDimmed(screenDimmed) {
        set((state) => ({ ui: { ...state.ui, screenDimmed } }));
      },
      touchActivity() {
        set((state) => ({ ui: { ...state.ui, lastActionAt: Date.now() } }));
      },
    }),
    {
      name: 'domus-kiosk-store',
      version: 5,
      // v5: la topologia non è più persistita nello store (vive in TanStack
      // Query + cache dedicata); restano solo preferenze e stato UI.
      partialize: (state): PersistedHome => ({
        broker: state.broker,
        ui: { ...state.ui, screenDimmed: false },
        telemetry: state.telemetry,
        burnIn: state.burnIn,
      }),
      migrate: (persisted) => persisted as PersistedHome,
      merge: (persisted, current) => {
        const saved = persisted as Partial<PersistedHome> | undefined;
        if (!saved) return current;
        return {
          ...current,
          broker: { ...current.broker, ...(saved.broker ?? {}) },
          ui: { ...current.ui, ...(saved.ui ?? {}), screenDimmed: false },
          telemetry: normalizeTelemetrySettings(saved.telemetry ?? current.telemetry),
          burnIn: normalizeBurnInSettings(saved.burnIn ?? current.burnIn),
        };
      },
    },
  ),
);

// ── Selettori atomici (evitano re-render inutili su update di latenza/log) ──
/** Solo la mappa: da evitare nei componenti, serve a pochi aggregatori. */
export const selectDeviceStates = (state: HomeState) => state.deviceStates;
/** Selettore mirato: un widget osserva solo la propria riga, non la mappa. */
export const selectDeviceState =
  (deviceId: string) =>
  (state: HomeState): DeviceRealtimeState | undefined =>
    state.deviceStates[deviceId];
export const selectTelemetrySettings = (state: HomeState) => state.telemetry;
export const selectConnection = (state: HomeState) => state.connection;
export const selectBroker = (state: HomeState) => state.broker;
export const selectUi = (state: HomeState) => state.ui;
