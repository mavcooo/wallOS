import { describe, expect, it } from 'vitest';

import {
  bandLimits,
  copyDay,
  daySegments,
  findFreeSlot,
  patchBand,
  timeFromMinutes,
  toInputs,
  weeklyCoverage,
  type DaySegment,
} from '@/lib/climateSchedule';
import type { ClimateScheduleDraft, DayOfWeek } from '@/types/climate';

function band(
  dayOfWeek: DayOfWeek,
  startMinute: number,
  endMinute: number,
  extra: Partial<ClimateScheduleDraft> = {},
): ClimateScheduleDraft {
  return {
    key: `${dayOfWeek}-${startMinute}`,
    dayOfWeek,
    startMinute,
    endMinute,
    targetTemp: 20,
    preset: 'comfort',
    isActive: true,
    ...extra,
  };
}

describe('orari', () => {
  it('fa round-trip tra minuti e HH:MM, compreso 24:00', () => {
    expect(timeFromMinutes(0)).toBe('00:00');
    expect(timeFromMinutes(390)).toBe('06:30');
    expect(timeFromMinutes(24 * 60)).toBe('24:00');
    expect(toInputs([band(1, 0, 24 * 60)])[0]).toMatchObject({
      startTime: '00:00',
      endTime: '24:00',
    });
  });
});

describe('patchBand', () => {
  const monday = [band(1, 360, 480), band(1, 1080, 1320)];

  it('non lascia invadere la fascia precedente', () => {
    const next = patchBand(monday, '1-1080', { startMinute: 400 });
    const moved = next.find((draft) => draft.key === '1-1080');

    expect(moved?.startMinute).toBe(480);
    expect(moved?.endMinute).toBe(1320);
  });

  it('non lascia invadere la fascia successiva', () => {
    const next = patchBand(monday, '1-360', { endMinute: 1200 });
    expect(next.find((draft) => draft.key === '1-360')?.endMinute).toBe(1080);
  });

  it('mantiene la durata minima di 15 minuti', () => {
    const next = patchBand(monday, '1-360', { endMinute: 365 });
    expect(next.find((draft) => draft.key === '1-360')?.endMinute).toBe(375);
  });

  it('arrotonda la temperatura allo step e resta nei limiti del device', () => {
    const warm = patchBand(monday, '1-360', { targetTemp: 21.26 });
    expect(warm.find((draft) => draft.key === '1-360')?.targetTemp).toBe(21.5);

    const tooHot = patchBand(monday, '1-360', { targetTemp: 99 });
    expect(tooHot.find((draft) => draft.key === '1-360')?.targetTemp).toBe(30);
  });

  it('espone i limiti della fascia per abilitare o disabilitare gli stepper', () => {
    expect(bandLimits(monday, '1-1080')).toEqual({ minStart: 480, maxEnd: 1440 });
    expect(bandLimits(monday, '1-360')).toEqual({ minStart: 0, maxEnd: 1080 });
  });
});

describe('daySegments', () => {
  it('copre l’intera giornata includendo i buchi', () => {
    const segments = daySegments([band(2, 360, 480)], 2);
    const total = segments.reduce(
      (sum: number, segment: DaySegment) => sum + (segment.endMinute - segment.startMinute),
      0,
    );

    expect(total).toBe(24 * 60);
    expect(segments.map((segment) => segment.kind)).toEqual(['gap', 'band', 'gap']);
  });

  it('ignora le fasce degli altri giorni', () => {
    expect(daySegments([band(2, 360, 480)], 3)).toHaveLength(1);
  });
});

describe('findFreeSlot', () => {
  it('propone 06:00–08:00 su un giorno vuoto', () => {
    expect(findFreeSlot([], 1)).toEqual({ startMinute: 360, endMinute: 480 });
  });

  it('resta nel primo buco abbastanza largo', () => {
    const slot = findFreeSlot([band(1, 360, 480)], 1);
    expect(slot).toEqual({ startMinute: 0, endMinute: 60 });
  });

  it('senza buchi non propone nulla', () => {
    expect(findFreeSlot([band(1, 0, 1440)], 1)).toBeNull();
  });
});

describe('copyDay', () => {
  it('sostituisce i giorni scelti e lascia intatti gli altri', () => {
    const drafts = [
      band(1, 360, 480),
      band(1, 1080, 1200),
      band(2, 400, 500),
      band(3, 600, 700),
    ];

    const copied = copyDay(drafts, 1, [2]);
    const tuesday = copied.filter((draft) => draft.dayOfWeek === 2);

    expect(tuesday).toHaveLength(2);
    expect(tuesday.map((draft) => draft.startMinute)).toEqual([360, 1080]);
    expect(copied.filter((draft) => draft.dayOfWeek === 3)).toHaveLength(1);
    // Le chiavi restano univoche: React non deve riusare per errore un blocco.
    expect(new Set(copied.map((item) => item.key)).size).toBe(copied.length);
  });
});

describe('weeklyCoverage', () => {
  it('somma solo le fasce attive', () => {
    const drafts = [band(1, 360, 480), band(2, 360, 480, { isActive: false })];
    expect(weeklyCoverage(drafts)).toBe(120);
  });
});
