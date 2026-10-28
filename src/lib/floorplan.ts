/**
 * Geometria e segnali della planimetria schematica.
 *
 * Funzioni pure, senza React e senza store: la griglia è una matrice 12×8 e
 * ogni stanza occupa un rettangolo di celle. Qui vivono la normalizzazione dei
 * payload (un JSON malformato non deve mai rompere il rendering), i limiti dello
 * snap-to-grid e l'aggregazione dei segnali che colorano stanza e sfondo.
 */

import type { DeviceRealtimeState, SensorState } from '@/types/device';
import type {
  DevicePinPosition,
  Floor,
  FloorRoom,
  FloorRoomDevice,
  RoomGridLayout,
} from '@/types/floorplan';

/** Matrice della pianta: 12 colonne × 8 righe, aspect ratio 16:10. */
export const FLOORPLAN_GRID = { cols: 12, rows: 8 } as const;

/** Stessa geometria del DEFAULT SQL: una stanza nuova occupa 3×2 partendo da 1,1. */
export const DEFAULT_ROOM_GRID_LAYOUT: RoomGridLayout = {
  col: 1,
  row: 1,
  colSpan: 3,
  rowSpan: 2,
  color: 'zinc',
};

/** Centro della stanza: usato finché un dispositivo non ha un marker salvato. */
export const DEFAULT_PIN_POSITION: DevicePinPosition = { x: 50, y: 50 };

/** Palette semantica del tema: nessun valore CSS arriva dal database. */
export const ROOM_COLORS = ['zinc', 'amber', 'teal', 'sky', 'rose'] as const;

export type RoomColor = (typeof ROOM_COLORS)[number];

export function isRoomColor(value: unknown): value is RoomColor {
  return typeof value === 'string' && (ROOM_COLORS as readonly string[]).includes(value);
}

/**
 * Classi statiche per colore: Tailwind non genera classi costruite a runtime,
 * quindi la mappa è esplicita e usa solo token del tema (alto contrasto incluso).
 */
export const ROOM_COLOR_CLASSES: Record<RoomColor, string> = {
  zinc: 'border-line bg-panel-2/80',
  amber: 'border-warning/30 bg-warning/[0.07]',
  teal: 'border-accent/30 bg-accent-soft/60',
  sky: 'border-cool/30 bg-cool/10',
  rose: 'border-danger/30 bg-danger/[0.07]',
};

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalizza `grid_layout` in un rettangolo sempre dentro la griglia:
 * un payload vecchio, corrotto o troppo grande non può sfondare il canvas.
 */
export function normalizeGridLayout(value: unknown): RoomGridLayout {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const colSpan = clamp(
    Math.round(finiteNumber(record.colSpan, DEFAULT_ROOM_GRID_LAYOUT.colSpan)),
    1,
    FLOORPLAN_GRID.cols,
  );
  const rowSpan = clamp(
    Math.round(finiteNumber(record.rowSpan, DEFAULT_ROOM_GRID_LAYOUT.rowSpan)),
    1,
    FLOORPLAN_GRID.rows,
  );
  const col = clamp(
    Math.round(finiteNumber(record.col, DEFAULT_ROOM_GRID_LAYOUT.col)),
    1,
    FLOORPLAN_GRID.cols - colSpan + 1,
  );
  const row = clamp(
    Math.round(finiteNumber(record.row, DEFAULT_ROOM_GRID_LAYOUT.row)),
    1,
    FLOORPLAN_GRID.rows - rowSpan + 1,
  );

  return {
    col,
    row,
    colSpan,
    rowSpan,
    color: isRoomColor(record.color) ? record.color : DEFAULT_ROOM_GRID_LAYOUT.color,
  };
}

/** Marker sempre dentro il perimetro: 0-100, con un piccolo margine visivo. */
export function normalizePinPosition(value: unknown): DevicePinPosition {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    x: clamp(finiteNumber(record.x, DEFAULT_PIN_POSITION.x), 0, 100),
    y: clamp(finiteNumber(record.y, DEFAULT_PIN_POSITION.y), 0, 100),
  };
}

/** Sposta un rettangolo di `dCol`/`dRow` celle, restando dentro la griglia. */
export function moveRoomLayout(
  layout: RoomGridLayout,
  dCol: number,
  dRow: number,
): RoomGridLayout {
  return {
    ...layout,
    col: clamp(layout.col + dCol, 1, FLOORPLAN_GRID.cols - layout.colSpan + 1),
    row: clamp(layout.row + dRow, 1, FLOORPLAN_GRID.rows - layout.rowSpan + 1),
  };
}

/** Ridimensiona la stanza trascinando l'angolo, con span minimo 1×1. */
export function resizeRoomLayout(
  layout: RoomGridLayout,
  dColSpan: number,
  dRowSpan: number,
): RoomGridLayout {
  return {
    ...layout,
    colSpan: clamp(layout.colSpan + dColSpan, 1, FLOORPLAN_GRID.cols - layout.col + 1),
    rowSpan: clamp(layout.rowSpan + dRowSpan, 1, FLOORPLAN_GRID.rows - layout.row + 1),
  };
}

/** `true` quando due stanze si sovrappongono (usato per il posizionamento libero). */
export function layoutsOverlap(a: RoomGridLayout, b: RoomGridLayout): boolean {
  return (
    a.col < b.col + b.colSpan &&
    a.col + a.colSpan > b.col &&
    a.row < b.row + b.rowSpan &&
    a.row + a.rowSpan > b.row
  );
}

/** Prima cella 3×2 libera: evita che una stanza appena aggiunta copra le altre. */
export function firstFreeLayout(occupied: readonly RoomGridLayout[]): RoomGridLayout {
  const { colSpan, rowSpan } = DEFAULT_ROOM_GRID_LAYOUT;
  for (let row = 1; row <= FLOORPLAN_GRID.rows - rowSpan + 1; row += 1) {
    for (let col = 1; col <= FLOORPLAN_GRID.cols - colSpan + 1; col += 1) {
      const candidate = { ...DEFAULT_ROOM_GRID_LAYOUT, col, row };
      if (!occupied.some((layout) => layoutsOverlap(candidate, layout))) return candidate;
    }
  }
  return { ...DEFAULT_ROOM_GRID_LAYOUT };
}

/** Sensori che rappresentano un allarme quando il valore è "attivo". */
export function isAlarmSensorState(state: SensorState | undefined): boolean {
  if (!state) return false;
  const { type, value } = state;
  if (type !== 'smoke' && type !== 'contact' && type !== 'motion') return false;
  // I contact/motion sono "attivi" quando aperti/rilevati; il fumo è binario.
  if (typeof value === 'boolean') return value;
  return typeof value === 'number' && value > 0;
}

/** Variante sul view-model realtime del device (planimetria e sfondo). */
export function isSecurityAlarm(state: DeviceRealtimeState | undefined): boolean {
  return state?.kind === 'sensor' && isAlarmSensorState(state.state);
}

/** Luce accesa: base del bagliore ambra della stanza e dello sfondo. */
export function isLightOn(state: DeviceRealtimeState | undefined): boolean {
  return state?.kind === 'light' && state.state.on;
}

export interface RoomSignals {
  /** Almeno una luce accesa nella stanza. */
  lightsOn: boolean;
  /** Almeno un sensore di sicurezza in allarme. */
  alarm: boolean;
  /** Media delle temperature note (clima + sensori), `null` se nessuna. */
  temperature: number | null;
  /** Media delle umidità note (clima + sensori), `null` se nessuna. */
  humidity: number | null;
}

const EMPTY_SIGNALS: RoomSignals = {
  lightsOn: false,
  alarm: false,
  temperature: null,
  humidity: null,
};

/**
 * Aggrega lo stato volatile dei dispositivi di una stanza. Le medie ignorano i
 * valori mancanti (un clima senza sensore di umidità non trascina a 0).
 */
export function roomSignals(
  devices: readonly FloorRoomDevice[],
  states: Readonly<Record<string, DeviceRealtimeState | undefined>>,
): RoomSignals {
  if (devices.length === 0) return EMPTY_SIGNALS;

  let lightsOn = false;
  let alarm = false;
  let temperatureSum = 0;
  let temperatureCount = 0;
  let humiditySum = 0;
  let humidityCount = 0;

  for (const device of devices) {
    const state = states[device.id];
    if (!state) continue;

    if (isLightOn(state)) lightsOn = true;
    if (isSecurityAlarm(state)) alarm = true;

    if (state.kind === 'climate') {
      if (Number.isFinite(state.state.currentTemp)) {
        temperatureSum += state.state.currentTemp;
        temperatureCount += 1;
      }
      if (typeof state.state.humidity === 'number' && Number.isFinite(state.state.humidity)) {
        humiditySum += state.state.humidity;
        humidityCount += 1;
      }
    } else if (state.kind === 'sensor') {
      if (state.state.type === 'temperature' && typeof state.state.value === 'number') {
        temperatureSum += state.state.value;
        temperatureCount += 1;
      } else if (state.state.type === 'humidity' && typeof state.state.value === 'number') {
        humiditySum += state.state.value;
        humidityCount += 1;
      }
    }
  }

  return {
    lightsOn,
    alarm,
    temperature: temperatureCount > 0 ? temperatureSum / temperatureCount : null,
    humidity: humidityCount > 0 ? humiditySum / humidityCount : null,
  };
}

/** Conteggi del piano per le chip del selettore (luci accese, allarmi attivi). */
export function floorSignals(
  floor: Floor | undefined,
  states: Readonly<Record<string, DeviceRealtimeState | undefined>>,
): { lightsOn: number; alarms: number } {
  if (!floor) return { lightsOn: 0, alarms: 0 };
  let lightsOn = 0;
  let alarms = 0;
  for (const room of floor.rooms) {
    for (const device of room.devices) {
      const state = states[device.id];
      if (isLightOn(state)) lightsOn += 1;
      if (isSecurityAlarm(state)) alarms += 1;
    }
  }
  return { lightsOn, alarms };
}

/** Stanze del piano ordinate per lettura (riga, poi colonna della griglia). */
export function orderedRooms(rooms: readonly FloorRoom[]): FloorRoom[] {
  return [...rooms].sort(
    (a, b) =>
      a.gridLayout.row - b.gridLayout.row || a.gridLayout.col - b.gridLayout.col,
  );
}
