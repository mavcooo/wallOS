import type {
  ClimatePreset,
  ClimateSchedule,
  ClimateScheduleDraft,
  ClimateScheduleInput,
  DayOfWeek,
} from '@/types/climate';
import { activeLocale } from '@/i18n';

/** Durata minima di una fascia e passo degli stepper degli orari. */
export const MIN_BAND_MINUTES = 15;
export const TIME_STEP_MINUTES = 15;
export const DAY_MINUTES = 24 * 60;

/** Ordine di visualizzazione: la settimana italiana parte dal lunedì. */
export const DAY_ORDER: readonly DayOfWeek[] = [1, 2, 3, 4, 5, 6, 0];

export function minutesFromTime(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  const parsed = Number.parseInt(hours, 10) * 60 + Number.parseInt(minutes, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function timeFromMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** Etichetta breve localizzata del giorno (`Lun`, `Mon`, …). */
export function weekdayLabel(day: DayOfWeek, style: 'short' | 'long' = 'short'): string {
  // 2024-01-07 è una domenica: `day` 0 = domenica, coerente con il database.
  const reference = new Date(2024, 0, 7 + day);
  return new Intl.DateTimeFormat(activeLocale(), { weekday: style }).format(reference);
}

export function isToday(day: DayOfWeek, now = new Date()): boolean {
  return now.getDay() === day;
}

export function draftsFromSchedules(schedules: readonly ClimateSchedule[]): ClimateScheduleDraft[] {
  return schedules
    .map((schedule) => ({
      key: schedule.id,
      id: schedule.id,
      dayOfWeek: schedule.dayOfWeek,
      startMinute: minutesFromTime(schedule.startTime),
      endMinute: minutesFromTime(schedule.endTime),
      targetTemp: schedule.targetTemp,
      preset: schedule.preset,
      isActive: schedule.isActive,
    }))
    .sort((left, right) =>
      left.dayOfWeek === right.dayOfWeek
        ? left.startMinute - right.startMinute
        : left.dayOfWeek - right.dayOfWeek,
    );
}

export function toInputs(drafts: readonly ClimateScheduleDraft[]): ClimateScheduleInput[] {
  return drafts.map((draft) => ({
    dayOfWeek: draft.dayOfWeek,
    startTime: timeFromMinutes(draft.startMinute),
    endTime: timeFromMinutes(draft.endMinute),
    targetTemp: draft.targetTemp,
    preset: draft.preset,
    isActive: draft.isActive,
  }));
}

export function bandsOfDay(
  drafts: readonly ClimateScheduleDraft[],
  day: DayOfWeek,
): ClimateScheduleDraft[] {
  return drafts
    .filter((draft) => draft.dayOfWeek === day && draft.isActive)
    .sort((left, right) => left.startMinute - right.startMinute);
}

export interface DaySegment {
  key: string;
  startMinute: number;
  endMinute: number;
  /** Fascia reale oppure buco (nessun comando programmato). */
  kind: 'band' | 'gap';
  preset?: ClimatePreset;
  targetTemp?: number;
}

/**
 * Segmenti 00:00–24:00 del giorno, buchi compresi: la timeline mostra anche
 * dove il programma non copre nulla (in quei tratti il termostato va in off).
 */
export function daySegments(
  drafts: readonly ClimateScheduleDraft[],
  day: DayOfWeek,
): DaySegment[] {
  const bands = bandsOfDay(drafts, day);
  const segments: DaySegment[] = [];
  let cursor = 0;

  for (const band of bands) {
    if (band.startMinute > cursor) {
      segments.push({
        key: `gap-${day}-${cursor}-${band.startMinute}`,
        startMinute: cursor,
        endMinute: band.startMinute,
        kind: 'gap',
      });
    }
    segments.push({
      key: band.key,
      startMinute: Math.max(band.startMinute, cursor),
      endMinute: band.endMinute,
      kind: 'band',
      preset: band.preset,
      targetTemp: band.targetTemp,
    });
    cursor = Math.max(cursor, band.endMinute);
  }

  if (cursor < DAY_MINUTES) {
    segments.push({
      key: `gap-${day}-${cursor}-end`,
      startMinute: cursor,
      endMinute: DAY_MINUTES,
      kind: 'gap',
    });
  }

  return segments;
}

export interface BandLimits {
  minStart: number;
  maxEnd: number;
}

/** Estremi entro cui una fascia può muoversi senza invadere le vicine. */
export function bandLimits(
  drafts: readonly ClimateScheduleDraft[],
  key: string,
): BandLimits {
  const draft = drafts.find((item) => item.key === key);
  if (!draft) return { minStart: 0, maxEnd: DAY_MINUTES };
  const neighbours = drafts
    .filter(
      (item) =>
        item.dayOfWeek === draft.dayOfWeek && item.key !== key && item.isActive,
    )
    .sort((left, right) => left.startMinute - right.startMinute);

  const before = neighbours.filter((item) => item.endMinute <= draft.startMinute);
  const previous = before[before.length - 1];
  const next = neighbours.find((item) => item.startMinute >= draft.endMinute);

  return {
    minStart: previous?.endMinute ?? 0,
    maxEnd: next?.startMinute ?? DAY_MINUTES,
  };
}

/**
 * Applica una modifica a una fascia rispettando vicini e durata minima.
 * Gli stepper del pannello passano sempre da qui: la sovrapposizione è
 * impossibile già nella bozza, quindi il salvataggio non può essere rifiutato.
 */
export function patchBand(
  drafts: readonly ClimateScheduleDraft[],
  key: string,
  patch: Partial<Pick<ClimateScheduleDraft, 'startMinute' | 'endMinute' | 'targetTemp' | 'preset'>>,
  bounds: { minTemp: number; maxTemp: number; tempStep: number } = {
    minTemp: 5,
    maxTemp: 30,
    tempStep: 0.5,
  },
): ClimateScheduleDraft[] {
  const { minStart, maxEnd } = bandLimits(drafts, key);

  return drafts.map((draft) => {
    if (draft.key !== key) return draft;
    let startMinute = draft.startMinute;
    let endMinute = draft.endMinute;

    if (patch.startMinute !== undefined) {
      startMinute = Math.min(
        Math.max(patch.startMinute, minStart),
        Math.max(minStart, maxEnd - MIN_BAND_MINUTES),
      );
      endMinute = Math.max(endMinute, startMinute + MIN_BAND_MINUTES);
    }
    if (patch.endMinute !== undefined) {
      endMinute = Math.max(
        Math.min(patch.endMinute, maxEnd),
        Math.min(maxEnd, startMinute + MIN_BAND_MINUTES),
      );
      startMinute = Math.min(startMinute, endMinute - MIN_BAND_MINUTES);
    }
    if (patch.targetTemp !== undefined) {
      const stepped =
        Math.round((patch.targetTemp - bounds.minTemp) / bounds.tempStep) * bounds.tempStep +
        bounds.minTemp;
      return {
        ...draft,
        targetTemp: Number(
          Math.min(bounds.maxTemp, Math.max(bounds.minTemp, stepped)).toFixed(1),
        ),
      };
    }

    return { ...draft, startMinute, endMinute, ...(patch.preset ? { preset: patch.preset } : {}) };
  });
}

/**
 * Prima finestra libera del giorno, per "Aggiungi fascia". Preferisce le 06:00
 * (l'orario in cui si alza il riscaldamento), altrimenti il primo buco da
 * almeno un'ora. `null` quando la giornata è già tutta coperta.
 */
export function findFreeSlot(
  drafts: readonly ClimateScheduleDraft[],
  day: DayOfWeek,
): { startMinute: number; endMinute: number } | null {
  const bands = bandsOfDay(drafts, day);
  if (bands.length === 0) return { startMinute: 6 * 60, endMinute: 8 * 60 };

  const gaps: { startMinute: number; endMinute: number }[] = [];
  let cursor = 0;
  for (const band of bands) {
    if (band.startMinute > cursor) gaps.push({ startMinute: cursor, endMinute: band.startMinute });
    cursor = Math.max(cursor, band.endMinute);
  }
  if (cursor < DAY_MINUTES) gaps.push({ startMinute: cursor, endMinute: DAY_MINUTES });

  const preferred = 6 * 60;
  const containing = gaps.find(
    (gap) => gap.startMinute <= preferred && gap.endMinute >= preferred + 60,
  );
  if (containing) {
    return { startMinute: preferred, endMinute: Math.min(containing.endMinute, preferred + 120) };
  }

  const first = gaps.find((gap) => gap.endMinute - gap.startMinute >= 60);
  return first ? { startMinute: first.startMinute, endMinute: first.startMinute + 60 } : null;
}

/** Copia le fasce di un giorno su altri giorni (sostituisce quelli scelti). */
export function copyDay(
  drafts: readonly ClimateScheduleDraft[],
  source: DayOfWeek,
  targets: readonly DayOfWeek[],
): ClimateScheduleDraft[] {
  const sourceBands = drafts.filter(
    (draft) => draft.dayOfWeek === source && draft.isActive,
  );
  const kept = drafts.filter((draft) => !targets.includes(draft.dayOfWeek));

  const copies = targets.flatMap((day) =>
    sourceBands.map((band, index) => ({
      ...band,
      key: `copy-${day}-${index}-${band.startMinute}-${band.endMinute}`,
      id: undefined,
      dayOfWeek: day,
    })),
  );

  return [...kept, ...copies].sort((left, right) =>
    left.dayOfWeek === right.dayOfWeek
      ? left.startMinute - right.startMinute
      : left.dayOfWeek - right.dayOfWeek,
  );
}

/** Minuti di programma coperti in una settimana (riepilogo del modale). */
export function weeklyCoverage(drafts: readonly ClimateScheduleDraft[]): number {
  return drafts
    .filter((draft) => draft.isActive)
    .reduce((total, draft) => total + Math.max(0, draft.endMinute - draft.startMinute), 0);
}
