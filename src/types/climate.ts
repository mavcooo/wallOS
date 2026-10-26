/**
 * Cronotermostato settimanale.
 *
 * `preset` è l'etichetta del *programma* (comfort/eco/auto/off), non la
 * modalità del firmware: il motore lato server la traduce nel payload MQTT
 * dell'adapter del dispositivo. `comfort` ed `eco` scaldano entrambi fino al
 * `targetTemp` della fascia, ma con temperature tipiche diverse: è il colore e
 * il senso del blocco nella timeline a distinguerli.
 */

export type ClimatePreset = 'comfort' | 'eco' | 'auto' | 'off';

export const CLIMATE_PRESETS: readonly ClimatePreset[] = ['comfort', 'eco', 'auto', 'off'];

/** 0 = Domenica … 6 = Sabato, come `Date.getDay()`. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Fascia come la restituisce il server: orari `HH:MM`, `24:00` ammesso. */
export interface ClimateSchedule {
  id: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  targetTemp: number;
  preset: ClimatePreset;
  isActive: boolean;
}

/** Fascia in modifica nel pannello: minuti dalla mezzanotte, più semplice da clampare. */
export interface ClimateScheduleDraft {
  /** Chiave locale del form (gli id del server cambiano a ogni salvataggio). */
  key: string;
  id?: string;
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
  targetTemp: number;
  preset: ClimatePreset;
  isActive: boolean;
}

/** Payload di salvataggio: il server sostituisce l'intera settimana. */
export interface ClimateScheduleInput {
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  targetTemp: number;
  preset: ClimatePreset;
  isActive: boolean;
}

export interface ClimateOverrideState {
  targetTemp: number;
  preset: ClimatePreset;
  /** Epoch ms; `null` insieme a `permanent` = finché non viene annullato. */
  until: number | null;
  permanent: boolean;
}

export interface ClimateVacationState {
  /** Epoch ms; `null` = senza data di rientro. */
  until: number | null;
  permanent: boolean;
}

export interface ClimateRuntimeState {
  override: ClimateOverrideState | null;
  vacation: ClimateVacationState | null;
  lastSent: { targetTemp: number | null; preset: ClimatePreset; at: number } | null;
}

export interface ClimateActiveSchedule {
  startTime: string;
  endTime: string;
  targetTemp: number;
  preset: ClimatePreset;
  endsAt: number | null;
}

/** `GET /api/climate/:deviceId/schedules`. */
export interface ClimateScheduleResponse {
  deviceId: string;
  deviceName: string;
  schedules: ClimateSchedule[];
  runtime: ClimateRuntimeState;
  activeSchedule: ClimateActiveSchedule | null;
  /** Epoch ms della prossima fascia, `null` se il programma è vuoto. */
  nextChangeAt: number | null;
}

/**
 * Durata dell'override scelta dal pannello:
 * - `next_schedule` → fino al prossimo cambio orario (default del server)
 * - `permanent` → manuale fino a cancellazione
 * Un `durationMinutes` esplicito ha la precedenza sulla durata simbolica.
 */
export type ClimateOverrideDuration =
  | { minutes: number }
  | { until: 'next_schedule' }
  | { until: 'permanent' };

export interface ClimateOverrideRequest {
  targetTemp: number;
  preset?: ClimatePreset;
  durationMinutes?: number;
  until?: 'next_schedule' | 'permanent';
}
