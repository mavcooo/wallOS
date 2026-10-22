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
