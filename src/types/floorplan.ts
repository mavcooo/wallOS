/**
 * Planimetria schematica multi-piano.
 *
 * La pianta non è un disegno importato: è generata da una griglia 12×8 e da
 * coordinate relative. Gli stessi numeri vivono in PostgreSQL (`floors`,
 * `rooms.grid_layout`, `devices.room_pin_position`) e arrivano al pannello da
 * `GET /api/floors`, quindi il layout è identico su ogni tablet della LAN e
 * modificabile dal touch senza file CAD.
 *
 * `Floor`, `FloorRoom` e `FloorRoomDevice` sono la forma annidata della risposta
 * del server (già normalizzata in camelCase). `RoomGridLayout` e
 * `DevicePinPosition` sono invece i due blocchi condivisi con `Room` e
 * `DeviceMetadata`.
 */

import type { DeviceKind } from './device';

/** Rettangolo di una stanza sulla griglia, coordinate 1-based e span inclusivi. */
export interface RoomGridLayout {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  /** Chiave semantica del tema: `zinc`, `amber`, `teal`, `sky`, `rose`. */
  color: string;
}

/** Marker del dispositivo dentro la stanza, in percentuale (0-100). */
export interface DevicePinPosition {
  x: number;
  y: number;
}

/** Dispositivo come arriva annidato nel piano (id, nome, tipo, marker). */
export interface FloorRoomDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  roomPinPosition: DevicePinPosition;
}

/** Stanza di un piano: etichette per la mappa e rettangolo sulla griglia. */
export interface FloorRoom {
  id: string;
  label: string;
  shortLabel: string;
  icon: string;
  floorId: string | null;
  gridLayout: RoomGridLayout;
  devices: FloorRoomDevice[];
}

/** Piano con le stanze associate e i relativi dispositivi. */
export interface Floor {
  id: string;
  name: string;
  levelOrder: number;
  icon: string;
  rooms: FloorRoom[];
}

/** Estensione planimetrica della stanza (`RoomConfig`). */
export interface RoomFloorplanExtension {
  /** Piano di appartenenza; `null` = stanza non ancora assegnata. */
  floorId?: string | null;
  gridLayout?: RoomGridLayout;
}

/** Estensione planimetrica dei metadati dispositivo. */
export interface DeviceFloorplanExtension {
  roomPinPosition?: DevicePinPosition;
}

/** Una stanza dentro `PUT /api/floors/:id/layout`. */
export interface FloorLayoutRoomInput {
  id: string;
  /**
   * Piano di destinazione. Assente = resta quello attuale; `null` = stanza
   * rimossa dalla pianta (nessun piano).
   */
  floorId?: string | null;
  gridLayout: RoomGridLayout;
}

/** Un marker dentro `PUT /api/floors/:id/layout`. */
export interface FloorLayoutDeviceInput {
  id: string;
  roomPinPosition: DevicePinPosition;
}

/**
 * Salvataggio bulk del layout: stanze e marker arrivano in un'unica richiesta e
 * il server li scrive in una sola transazione (o tutti o nessuno).
 */
export interface FloorLayoutPayload {
  rooms: FloorLayoutRoomInput[];
  devices: FloorLayoutDeviceInput[];
}

/** Campi modificabili di un piano (l'id si sceglie solo alla creazione). */
export interface FloorPayload {
  id?: string;
  name: string;
  levelOrder?: number;
  /** Nome icona Lucide mostrato nel selettore. */
  icon?: string;
}
