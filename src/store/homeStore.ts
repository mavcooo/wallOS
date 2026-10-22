import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_BROKER, KIOSK_DEFAULTS, PIN_RULES } from '@/config/app.config';
import { initialDevices } from '@/config/devices.config';
import {
  ROOMS,
  UNASSIGNED_ROOM_ID,
  roomIdFromLabel,
  type RoomConfig,
} from '@/config/rooms.config';
import { DEFAULT_USERS, type LocalUser } from '@/config/users.config';
import { DEFAULT_PIN, hashPin, verifyPinHash } from '@/lib/pin';
import { normalizeTelemetrySettings } from '@/lib/telemetry';
import type { DecodedState, Device, DeviceAvailability, RoomId } from '@/types/device';
import type { BrokerSettings, ConnectionMetrics, ConnectionStatus } from '@/types/mqtt';
import type { RawMqttMessage } from '@/types/mqtt';
import type { TelemetrySettings, TelemetryUpdate } from '@/types/telemetry';

export type ViewId = 'overview' | 'rooms' | 'energy' | 'settings' | 'users';

export interface UiState {
  view: ViewId;
  room: RoomId;
  dimmerTimeoutMs: number;
  screenDimmed: boolean;
  activeUserId: string;
  kioskProfileId: string;
  lastActionAt: number;
}

type DeviceMap = Record<string, Device>;

export interface HomeState {
  // ── Entità ───────────────────────────────────────────────────────────────
  devices: DeviceMap;
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

  // ── Stanze ───────────────────────────────────────────────────────────────
  /** Stanze disponibili: seed statico + aree scoperte via HA Discovery. */
  rooms: RoomConfig[];
  /** Crea (o riusa, se l'etichetta coincide) la stanza di un'area HA. */
  ensureRoom(label?: string): RoomId;

  // ── Discovery Home Assistant ─────────────────────────────────────────────
  /** Inserisce o aggiorna un device annunciato; la discovery vince sul seed. */
  applyDiscoveryUpsert(device: Device): void;
  /** Ritira l'entità: il widget sparisce, nessun orfano in UI. */
  applyDiscoveryRemove(entityId: string): void;

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
  ui: UiState;
  setView(view: ViewId): void;
  setRoom(room: RoomId): void;
  setDimmerTimeout(ms: number): void;
  setScreenDimmed(dimmed: boolean): void;
  setActiveUser(userId: string): void;
  touchActivity(): void;

  // ── PIN / utenti ─────────────────────────────────────────────────────────
  pinHash: string | null;
  pinLength: 4 | 6;
  pinAttempts: number;
  pinLockedUntil: number;
  ensurePin(): Promise<void>;
  verifyPin(pin: string): Promise<boolean>;
  setPin(pin: string): Promise<void>;
  registerPinFailure(): { attempts: number; lockedUntil: number };
  resetPinFailures(): void;
  users: LocalUser[];
  updateUser(userId: string, patch: Partial<LocalUser>): void;
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
  activeUserId: 'user-panel',
  kioskProfileId: 'user-panel',
  lastActionAt: Date.now(),
};

function seedDevices(): DeviceMap {
  return Object.fromEntries(initialDevices.map((device) => [device.id, device]));
}

/** Il seed ha la precedenza per le stanze note; quelle scoperte si aggiungono. */
function mergeRooms(
  seed: readonly RoomConfig[],
  saved?: readonly RoomConfig[],
): RoomConfig[] {
  const merged = [...seed];
  for (const room of saved ?? []) {
    if (!room?.id || !room.label) continue;
    if (!merged.some((existing) => existing.id === room.id)) merged.push(room);
  }
  return merged;
}

/** Applica una patch solo se il discriminante coincide con il tipo di device. */
function mergeDecoded(device: Device, decoded: DecodedState): Device {
  if (device.kind !== decoded.kind) return device;
  switch (device.kind) {
    case 'light':
      return decoded.kind === 'light'
        ? { ...device, state: { ...device.state, ...decoded.state } }
        : device;
    case 'climate':
      return decoded.kind === 'climate'
        ? { ...device, state: { ...device.state, ...decoded.state } }
        : device;
    case 'power':
      return decoded.kind === 'power'
        ? { ...device, state: { ...device.state, ...decoded.state } }
        : device;
    case 'media':
      return decoded.kind === 'media'
        ? { ...device, state: { ...device.state, ...decoded.state } }
        : device;
    case 'sensor':
      return decoded.kind === 'sensor'
        ? { ...device, state: { ...device.state, ...decoded.state } }
        : device;
  }
}

function jitter(value: number, amplitude: number, min: number): number {
  return Math.max(min, value + (Math.random() - 0.5) * amplitude);
}

type PersistedHome = Pick<
  HomeState,
  'broker' | 'ui' | 'pinHash' | 'pinLength' | 'users' | 'telemetry' | 'rooms'
> & {
  /** Solo i device scoperti: quelli statici tornano dal seed a ogni avvio. */
  discovered: Device[];
};

export const useHomeStore = create<HomeState>()(
  persist(
    (set, get) => ({
      devices: seedDevices(),
      rooms: [...ROOMS],

      ensureRoom(label) {
        const clean = label?.trim();
        if (!clean) return UNASSIGNED_ROOM_ID;

        const { rooms } = get();
        const byLabel = rooms.find(
          (room) => room.label.toLowerCase() === clean.toLowerCase(),
        );
        if (byLabel) return byLabel.id;

        const id = roomIdFromLabel(clean);
        if (rooms.some((room) => room.id === id)) return id;

        set({
          rooms: [
            ...rooms,
            {
              id,
              label: clean,
              shortLabel: clean.length > 12 ? `${clean.slice(0, 11)}…` : clean,
            },
          ],
        });
        return id;
      },

      applyDiscoveryUpsert(device) {
        const room = get().ensureRoom(device.discovery?.area);
        set((state) => {
          const existing = state.devices[device.id];
          // Su un re-annuncio (retained all'avvio) i metadati si aggiornano ma
          // stato, disponibilità e preferito già noti non vengono azzerati.
          const runtime =
            existing && existing.kind === device.kind
              ? {
                  favorite: existing.favorite,
                  availability: existing.availability,
                  lastSeen: existing.lastSeen,
                  // I default dell'annuncio non devono cancellare lo stato già
                  // ricevuto dal broker.
                  state: { ...device.state, ...existing.state },
                }
              : { favorite: existing?.favorite ?? device.favorite };

          return {
            devices: {
              ...state.devices,
              [device.id]: { ...device, room, ...runtime } as Device,
            },
          };
        });
      },

      applyDiscoveryRemove(entityId) {
        set((state) => {
          const ids = Object.values(state.devices)
            .filter((device) => device.discovery?.entityId === entityId)
            .map((device) => device.id);
          if (ids.length === 0) return state;

          const devices = { ...state.devices };
          for (const id of ids) delete devices[id];
          return { devices };
        });
      },

      applyDecoded(deviceId, decoded) {
        set((state) => {
          const device = state.devices[deviceId];
          if (!device) return state;
          const next = mergeDecoded(device, decoded);
          if (next === device) return state;
          return {
            devices: {
              ...state.devices,
              [deviceId]: { ...next, availability: 'online', lastSeen: Date.now() },
            },
          };
        });
      },

      applyOptimistic(deviceId, decoded) {
        set((state) => {
          const device = state.devices[deviceId];
          if (!device) return state;
          const next = mergeDecoded(device, decoded);
          if (next === device) return state;
          return {
            devices: { ...state.devices, [deviceId]: next },
          };
        });
      },

      applyTelemetryBatch(updates) {
        if (updates.length === 0) return;
        set((state) => {
          // Una sola copia della mappa e una sola `set` per l'intero batch:
          // i device non toccati conservano lo stesso riferimento in memoria.
          const devices: DeviceMap = { ...state.devices };
          let changed = false;
          for (const update of updates) {
            const device = devices[update.deviceId];
            if (!device) continue;
            const merged = mergeDecoded(device, update.decoded);
            if (merged === device) continue;
            devices[update.deviceId] = {
              ...merged,
              availability: 'online',
              // Timestamp di arrivo, mai regressioni anche con flush fuori ordine.
              lastSeen: Math.max(device.lastSeen ?? 0, update.at),
            };
            changed = true;
          }
          return changed ? { devices } : state;
        });
      },

      setAvailability(deviceId, availability) {
        set((state) => {
          const device = state.devices[deviceId];
          if (!device) return state;
          return {
            devices: { ...state.devices, [deviceId]: { ...device, availability } },
          };
        });
      },

      toggleFavorite(deviceId) {
        set((state) => {
          const device = state.devices[deviceId];
          if (!device) return state;
          return {
            devices: {
              ...state.devices,
              [deviceId]: { ...device, favorite: !device.favorite },
            },
          };
        });
      },

      simulateTelemetry() {
        set((state) => {
          const now = Date.now();
          const devices: DeviceMap = { ...state.devices };
          for (const [id, device] of Object.entries(state.devices)) {
            if (device.kind === 'power') {
              const base = device.state.on ? Math.max(5, device.state.watts) : 0;
              const watts = Math.round(jitter(base, device.state.on ? 40 : 0, 0));
              devices[id] = {
                ...device,
                lastSeen: now,
                state: {
                  ...device.state,
                  watts,
                  voltage: Math.round(jitter(230, 4, 215)),
                  current: Number((watts / 230).toFixed(2)),
                  energyTodayKwh: Number(
                    (device.state.energyTodayKwh + watts / 3_600_000 * 3).toFixed(3),
                  ),
                  energyTotalKwh: Number(
                    (device.state.energyTotalKwh + watts / 3_600_000 * 3).toFixed(3),
                  ),
                },
              };
            } else if (device.kind === 'climate') {
              const { state: climate } = device;
              const active = climate.mode !== 'off';
              const delta = active ? climate.targetTemp - climate.currentTemp : 0;
              const currentTemp = Number(
                (climate.currentTemp + Math.max(-0.1, Math.min(0.1, delta * 0.05))).toFixed(1),
              );
              devices[id] = {
                ...device,
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
            } else if (device.kind === 'sensor' && typeof device.state.value === 'number') {
              const amp = device.state.type === 'co2' ? 30 : 0.4;
              devices[id] = {
                ...device,
                lastSeen: now,
                state: {
                  ...device.state,
                  value: Number(jitter(device.state.value, amp, 0).toFixed(1)),
                },
              };
            }
          }
          return { devices };
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
      setActiveUser(activeUserId) {
        set((state) => ({ ui: { ...state.ui, activeUserId } }));
      },
      touchActivity() {
        set((state) => ({ ui: { ...state.ui, lastActionAt: Date.now() } }));
      },

      pinHash: null,
      pinLength: 4,
      pinAttempts: 0,
      pinLockedUntil: 0,
      async ensurePin() {
        if (get().pinHash) return;
        set({ pinHash: await hashPin(DEFAULT_PIN), pinLength: DEFAULT_PIN.length === 6 ? 6 : 4 });
      },
      async verifyPin(pin) {
        if (!get().pinHash) await get().ensurePin();
        const hash = get().pinHash;
        return hash ? verifyPinHash(pin, hash) : false;
      },
      async setPin(pin) {
        set({
          pinHash: await hashPin(pin),
          pinLength: pin.length === 6 ? 6 : 4,
          pinAttempts: 0,
          pinLockedUntil: 0,
        });
      },
      registerPinFailure() {
        const attempts = get().pinAttempts + 1;
        const lockedUntil =
          attempts >= PIN_RULES.maxAttempts
            ? Date.now() + PIN_RULES.lockoutMs
            : get().pinLockedUntil;
        set({ pinAttempts: attempts, pinLockedUntil: lockedUntil });
        return { attempts, lockedUntil };
      },
      resetPinFailures() {
        set({ pinAttempts: 0, pinLockedUntil: 0 });
      },

      users: [...DEFAULT_USERS],
      updateUser(userId, patch) {
        set((state) => ({
          users: state.users.map((user) =>
            user.id === userId ? { ...user, ...patch } : user,
          ),
        }));
      },
    }),
    {
      name: 'domus-kiosk-store',
      version: 2,
      partialize: (state): PersistedHome => ({
        broker: state.broker,
        ui: { ...state.ui, screenDimmed: false },
        pinHash: state.pinHash,
        pinLength: state.pinLength,
        users: state.users,
        telemetry: state.telemetry,
        rooms: state.rooms,
        // Cache dell'albero scoperto: i widget compaiono prima che il broker
        // consegni i retained. I device statici tornano dal seed.
        discovered: Object.values(state.devices).filter(
          (device) => device.discovery !== undefined,
        ),
      }),
      // v1 non aveva stanze dinamiche né cache della discovery: il `merge`
      // sotto tollera entrambi i campi mancanti, serve solo la nuova versione.
      migrate: (persisted) => persisted as PersistedHome,
      merge: (persisted, current) => {
        const saved = persisted as Partial<PersistedHome> | undefined;
        if (!saved) return current;
        const discovered = (saved.discovered ?? []).filter(
          (device): device is Device =>
            typeof device?.id === 'string' && device.discovery !== undefined,
        );
        return {
          ...current,
          broker: { ...current.broker, ...(saved.broker ?? {}) },
          ui: { ...current.ui, ...(saved.ui ?? {}), screenDimmed: false },
          pinHash: saved.pinHash ?? current.pinHash,
          pinLength: saved.pinLength ?? current.pinLength,
          users: saved.users ?? current.users,
          telemetry: normalizeTelemetrySettings(saved.telemetry ?? current.telemetry),
          rooms: mergeRooms(ROOMS, saved.rooms),
          devices: {
            ...current.devices,
            ...Object.fromEntries(
              discovered.map((device) => [
                device.id,
                // La disponibilità salvata è di una sessione fa: si riparte da
                // `unknown` finché availability/stat non arrivano dal broker.
                { ...device, availability: 'unknown' as const },
              ]),
            ),
          },
        };
      },
    },
  ),
);

// ── Selettori atomici (evitano re-render inutili su update di latenza/log) ──
export const selectDevices = (state: HomeState) => state.devices;
/** Selettore mirato: un widget osserva solo il proprio device, non la mappa. */
export const selectDevice =
  (deviceId: string) =>
  (state: HomeState): Device | undefined =>
    state.devices[deviceId];
export const selectTelemetrySettings = (state: HomeState) => state.telemetry;
export const selectConnection = (state: HomeState) => state.connection;
export const selectBroker = (state: HomeState) => state.broker;
export const selectUi = (state: HomeState) => state.ui;
