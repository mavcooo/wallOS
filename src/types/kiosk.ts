/**
 * Configurazione di un display a parete (Kiosk Profile).
 *
 * Lato server la riga vive in `kiosk_displays` (`server/migrations/006_…`): il
 * pannello la idrata all'avvio e l'amministratore la modifica da Admin → Display.
 * Prima di questa tabella le stesse preferenze stavano solo nel localStorage del
 * browser e sparivano con una cache svuotata o un tablet sostituito.
 */

export type KioskScreensaverMode = 'clock_float' | 'black' | 'off';

export type KioskOrientation = 'landscape' | 'portrait';

export interface KioskDisplay {
  id: string;
  name: string;
  /** Stanza aperta all'avvio; `null` = Overview. */
  defaultRoomId: string | null;
  /** Timeout di inattività del dimmer, in secondi (30-600). */
  dimmerTimeoutSec: number;
  dimmerScreensaverMode: KioskScreensaverMode;
  /** Disattiva blur, ombre e animazioni sui pannelli con GPU debole. */
  performanceMode: boolean;
  /** Modalità luce solare (WCAG AAA). */
  highContrast: boolean;
  /** PIN richiesto per i comandi sui device protetti. */
  pinRequired: boolean;
  screenOrientation: KioskOrientation;
  isActive: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** `last_seen_at` entro la finestra di presenza del server. */
  online: boolean;
}

/** Campi che il pannello (o l'admin) può cambiare con `PUT /api/kiosk/:id`. */
export type KioskDisplayPatch = Partial<
  Pick<
    KioskDisplay,
    | 'name'
    | 'defaultRoomId'
    | 'dimmerTimeoutSec'
    | 'dimmerScreensaverMode'
    | 'performanceMode'
    | 'highContrast'
    | 'pinRequired'
    | 'screenOrientation'
    | 'isActive'
  >
>;

/** Limiti del timeout, gli stessi della migrazione e della route. */
export const KIOSK_DIMMER_LIMITS = { minSec: 30, maxSec: 600 } as const;

/** Default di un display appena auto-registrato: identici a quelli SQL. */
export const KIOSK_DISPLAY_DEFAULTS: Omit<
  KioskDisplay,
  'id' | 'name' | 'defaultRoomId' | 'lastSeenAt' | 'createdAt' | 'updatedAt' | 'online'
> = {
  dimmerTimeoutSec: 120,
  dimmerScreensaverMode: 'clock_float',
  performanceMode: false,
  highContrast: false,
  pinRequired: true,
  screenOrientation: 'landscape',
  isActive: true,
};

/** Come si muove l'orologio quando il dimmer è attivo. */
export type BurnInMode = 'subtle-shift' | 'screensaver-float';

export interface BurnInSettings {
  /** Strategia del dimmer: micro-oscillazione o spostamento libero. */
  mode: BurnInMode;
  /** Intervallo tra uno spostamento e il successivo. */
  shiftIntervalMs: number;
  /** Opacità dell'orologio in standby: bassa, per ridurre l'usura dei pixel. */
  dimClockOpacity: number;
}
