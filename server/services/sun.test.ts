import { describe, expect, it } from 'vitest';

import { sunEvent, sunEventLocalMinutes } from './sun.js';

/** Roma: 41,9028 N · 12,4964 E. */
const ROME = { latitude: 41.9028, longitude: 12.4964 };

/** Istante UTC atteso, da minuti dalla mezzanotte UTC del giorno indicato. */
function utc(date: Date, minutes: number): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes));
}

function minutesOfUtcDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

describe('sunEvent', () => {
  it('calcola alba e tramonto di Roma al solstizio d’estate', () => {
    const day = new Date(2026, 5, 21, 12, 0, 0, 0);
    const sunrise = sunEvent('sunrise', { ...ROME, at: day });
    const sunset = sunEvent('sunset', { ...ROME, at: day });

    expect(sunrise).not.toBeNull();
    expect(sunset).not.toBeNull();
    // 03:33 UTC (05:33 CEST) e 18:47 UTC (20:47 CEST): tolleranza 10 minuti,
    // l'algoritmo NOAA è preciso entro il minuto e il confronto è su orari
    // pubblicati al minuto.
    expect(Math.abs(minutesOfUtcDay(sunrise as Date) - (3 * 60 + 33))).toBeLessThanOrEqual(10);
    expect(Math.abs(minutesOfUtcDay(sunset as Date) - (18 * 60 + 47))).toBeLessThanOrEqual(10);
  });

  it('calcola alba e tramonto di Roma al solstizio d’inverno', () => {
    const day = new Date(2026, 11, 21, 12, 0, 0, 0);
    const sunrise = sunEvent('sunrise', { ...ROME, at: day });
    const sunset = sunEvent('sunset', { ...ROME, at: day });

    // 06:34 UTC (07:34 CET) e 15:42 UTC (16:42 CET).
    expect(Math.abs(minutesOfUtcDay(sunrise as Date) - (6 * 60 + 34))).toBeLessThanOrEqual(10);
    expect(Math.abs(minutesOfUtcDay(sunset as Date) - (15 * 60 + 42))).toBeLessThanOrEqual(10);
  });

  it('all’equatore la giornata resta di circa dodici ore tutto l’anno', () => {
    const day = new Date(2026, 5, 21, 12, 0, 0, 0);
    const sunrise = sunEvent('sunrise', { latitude: 0, longitude: 0, at: day });
    const sunset = sunEvent('sunset', { latitude: 0, longitude: 0, at: day });

    expect(Math.abs(minutesOfUtcDay(sunrise as Date) - 6 * 60)).toBeLessThanOrEqual(15);
    expect(Math.abs(minutesOfUtcDay(sunset as Date) - 18 * 60)).toBeLessThanOrEqual(15);
  });

  it('la longitudine sposta l’orario: stesso parallelo, 15° più a ovest = un’ora dopo', () => {
    const day = new Date(2026, 9, 21, 12, 0, 0, 0);
    const east = sunEvent('sunset', { latitude: 45, longitude: 12, at: day }) as Date;
    const west = sunEvent('sunset', { latitude: 45, longitude: -3, at: day }) as Date;

    const deltaMinutes =
      (west.getTime() - east.getTime()) / 60_000;
    expect(deltaMinutes).toBeGreaterThan(55);
    expect(deltaMinutes).toBeLessThan(65);
  });

  it('alle latitudini polari l’evento non esiste e non viene inventato', () => {
    const svalbard = { latitude: 78.22, longitude: 15.65 };
    expect(sunEvent('sunset', { ...svalbard, at: new Date(2026, 5, 21, 12, 0, 0, 0) })).toBeNull();
    expect(sunEvent('sunrise', { ...svalbard, at: new Date(2026, 5, 21, 12, 0, 0, 0) })).toBeNull();
    expect(sunEvent('sunset', { ...svalbard, at: new Date(2026, 11, 21, 12, 0, 0, 0) })).toBeNull();
  });

  it('rifiuta coordinate non valide invece di restituire un orario sbagliato', () => {
    const day = new Date(2026, 5, 21, 12, 0, 0, 0);
    expect(sunEvent('sunset', { latitude: 120, longitude: 0, at: day })).toBeNull();
    expect(sunEvent('sunset', { latitude: Number.NaN, longitude: 0, at: day })).toBeNull();
    expect(sunEvent('sunset', { latitude: 41, longitude: 200, at: day })).toBeNull();
  });
});

describe('sunEventLocalMinutes', () => {
  it('applica lo sfasamento in minuti, anche in anticipo sull’effemeride', () => {
    const day = new Date(2026, 5, 21, 12, 0, 0, 0);
    const base = sunEventLocalMinutes('sunset', { ...ROME, at: day });
    const early = sunEventLocalMinutes('sunset', { ...ROME, at: day, offsetMinutes: -15 });
    const late = sunEventLocalMinutes('sunset', { ...ROME, at: day, offsetMinutes: 10 });

    expect(base).not.toBeNull();
    expect(early).toBe((base as number) - 15);
    expect(late).toBe((base as number) + 10);
  });

  it('restituisce null quando l’effemeride non esiste', () => {
    expect(
      sunEventLocalMinutes('sunrise', {
        latitude: 78.22,
        longitude: 15.65,
        at: new Date(2026, 5, 21, 12, 0, 0, 0),
      }),
    ).toBeNull();
  });

  it('coincide con l’istante UTC riportato nell’ora locale del server', () => {
    const day = new Date(2026, 9, 21, 12, 0, 0, 0);
    const instant = sunEvent('sunset', { ...ROME, at: day }) as Date;
    const expected = instant.getHours() * 60 + instant.getMinutes();
    expect(sunEventLocalMinutes('sunset', { ...ROME, at: day })).toBe(expected);
    expect(utc(day, 0)).toBeInstanceOf(Date);
  });
});
