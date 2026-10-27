import { describe, expect, it } from 'vitest';

import {
  CronError,
  isValidCron,
  matchesCron,
  minuteStamp,
  parseCron,
} from './cron.js';

/** Mercoledì 21 ottobre 2026, 23:00 locali (0 = domenica → 3 = mercoledì). */
const WEDNESDAY_23 = new Date(2026, 9, 21, 23, 0, 0, 0);

describe('parseCron', () => {
  it('legge i cinque campi di un’espressione semplice', () => {
    const cron = parseCron('0 23 * * *');
    expect([...cron.minutes]).toEqual([0]);
    expect([...cron.hours]).toEqual([23]);
    expect(cron.dayOfMonthRestricted).toBe(false);
    expect(cron.dayOfWeekRestricted).toBe(false);
  });

  it('espande liste, intervalli e passi', () => {
    const cron = parseCron('*/15 6-8 1,15 * 1-5');
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([6, 7, 8]);
    expect([...cron.daysOfMonth]).toEqual([1, 15]);
    expect([...cron.months]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(cron.dayOfWeekRestricted).toBe(true);
  });

  it('accetta 7 come domenica, come 0', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCron('0 0 * * 0').daysOfWeek]).toEqual([0]);
  });

  it('rifiuta espressioni malformate con un messaggio leggibile', () => {
    expect(() => parseCron('0 23 * *')).toThrow(CronError);
    expect(() => parseCron('0 23 * * * *')).toThrow(/5 campi/);
    expect(() => parseCron('60 23 * * *')).toThrow(/minuto/);
    expect(() => parseCron('0 24 * * *')).toThrow(/ora/);
    expect(() => parseCron('0 23 0 * *')).toThrow(/giorno del mese/);
    expect(() => parseCron('0 23 * 13 *')).toThrow(/mese/);
    expect(() => parseCron('0 23 * * 8')).toThrow(/giorno della settimana/);
    expect(() => parseCron('10-5 * * * *')).toThrow(/al contrario/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/passo/);
    expect(() => parseCron('abc * * * *')).toThrow(/non è un numero/);
  });

  it('`isValidCron` non lancia mai', () => {
    expect(isValidCron('0 7 * * 1-5')).toBe(true);
    expect(isValidCron('non una cron')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });
});

describe('matchesCron', () => {
  it('scatta solo nel minuto esatto', () => {
    const cron = parseCron('0 23 * * *');
    expect(matchesCron(cron, WEDNESDAY_23)).toBe(true);
    expect(matchesCron(cron, new Date(2026, 9, 21, 23, 1, 0, 0))).toBe(false);
    expect(matchesCron(cron, new Date(2026, 9, 21, 22, 0, 0, 0))).toBe(false);
  });

  it('un intervallo non scatta fuori dalla finestra', () => {
    const cron = parseCron('*/30 7-9 * * *');
    expect(matchesCron(cron, new Date(2026, 9, 21, 7, 30))).toBe(true);
    expect(matchesCron(cron, new Date(2026, 9, 21, 10, 0))).toBe(false);
    expect(matchesCron(cron, new Date(2026, 9, 21, 7, 15))).toBe(false);
  });

  it('giorno del mese e giorno della settimana ristretti usano l’OR', () => {
    // Vixie cron: 1° del mese *oppure* lunedì. Il 21/10/2026 è mercoledì e non
    // è il 1°: non deve scattare.
    const cron = parseCron('0 8 1 * 1');
    expect(matchesCron(cron, new Date(2026, 9, 21, 8, 0))).toBe(false);
    // 1 novembre 2026 è domenica: vince il giorno del mese.
    expect(matchesCron(cron, new Date(2026, 10, 1, 8, 0))).toBe(true);
    // 26 ottobre 2026 è lunedì: vince il giorno della settimana.
    expect(matchesCron(cron, new Date(2026, 9, 26, 8, 0))).toBe(true);
  });

  it('con un solo campo giorno ristretto vale l’AND implicito', () => {
    const cron = parseCron('0 8 * * 1');
    expect(matchesCron(cron, new Date(2026, 9, 26, 8, 0))).toBe(true); // lunedì
    expect(matchesCron(cron, new Date(2026, 9, 21, 8, 0))).toBe(false); // mercoledì
  });

  it('rispetta il mese', () => {
    const cron = parseCron('0 9 1 12 *');
    expect(matchesCron(cron, new Date(2026, 11, 1, 9, 0))).toBe(true);
    expect(matchesCron(cron, new Date(2026, 10, 1, 9, 0))).toBe(false);
  });
});

describe('minuteStamp', () => {
  it('identifica il minuto locale, così un tick ripetuto non riesegue la regola', () => {
    expect(minuteStamp(WEDNESDAY_23)).toBe('2026-10-21T23:00');
    expect(minuteStamp(new Date(2026, 0, 3, 4, 5, 59, 0))).toBe('2026-01-03T04:05');
    expect(minuteStamp(WEDNESDAY_23)).toBe(minuteStamp(new Date(2026, 9, 21, 23, 0, 42, 0)));
  });
});
