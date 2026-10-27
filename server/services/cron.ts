/**
 * Espressioni cron a 5 campi, valutate sui minuti dell'orologio **locale** del
 * server (lo stesso riferimento del cronotermostato: un pannello a parete di
 * casa e il suo backend condividono il fuso).
 *
 *     ┌──────── minuto        (0-59)
 *     │ ┌────── ora           (0-23)
 *     │ │ ┌──── giorno del mese (1-31)
 *     │ │ │ ┌── mese          (1-12)
 *     │ │ │ │ ┌ giorno della settimana (0-7, 0 e 7 = domenica)
 *     * * * * *
 *
 * Sintassi per campo: `*`, valore singolo, `a-b`, lista `a,b,c`, passo `*\/n`
 * e intervallo con passo `a-b/n`. Nessun nome letterale (`MON`, `JAN`): le
 * regole del pannello sono generate da un builder, e accettare due dialetti
 * per la stessa cosa rende solo più difficile capire perché una regola non
 * scatta.
 *
 * Il campo giorno segue la regola standard di Vixie cron: se **entrambi**
 * giorno-del-mese e giorno-della-settimana sono ristretti (diversi da `*`) la
 * data corrisponde quando **almeno uno** dei due combacia; altrimenti valgono
 * entrambi in AND.
 *
 * L'implementazione è interna e senza dipendenze: `node-cron` non è nel
 * progetto e il motore ha bisogno solo di una valutazione booleana al minuto,
 * non di un timer per ogni regola.
 */

/** Somma minima e massima ammessa per campo, nell'ordine `[minimo, massimo]`. */
const FIELD_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const FIELD_NAMES = ['minuto', 'ora', 'giorno del mese', 'mese', 'giorno della settimana'];

export interface ParsedCron {
  /** Espressione originale, per log e messaggi d'errore. */
  expression: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** Giorni della settimana normalizzati: 7 → 0 (domenica). */
  daysOfWeek: ReadonlySet<number>;
  /** `false` quando il campo era `*`: serve alla regola OR del giorno. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/** Errore di sintassi: il messaggio è già pronto per il pannello. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

function parseField(
  raw: string,
  index: number,
  parsed: {
    minutes: Set<number>;
    hours: Set<number>;
    daysOfMonth: Set<number>;
    months: Set<number>;
    daysOfWeek: Set<number>;
  },
): boolean {
  const [minimum = 0, maximum = 0] = FIELD_RANGES[index] ?? [0, 0];
  const label = FIELD_NAMES[index] ?? `campo ${index + 1}`;
  const values = new Set<number>();
  let restricted = false;

  for (const part of raw.split(',')) {
    const item = part.trim();
    if (item.length === 0) {
      throw new CronError(`Campo ${label} vuoto nell’espressione cron`);
    }

    // Passo: `*/5`, `1-30/2`, `10/5` (da 10 al massimo, a passi di 5).
    const [rangePart, stepPart, ...extra] = item.split('/');
    if (extra.length > 0) {
      throw new CronError(`Campo ${label}: troppi "/" in "${item}"`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronError(`Campo ${label}: il passo "${stepPart}" deve essere un intero positivo`);
      }
    }

    let start = minimum;
    let end = maximum;
    if (rangePart !== '*' && rangePart !== undefined) {
      const bounds = rangePart.split('-');
      if (bounds.length > 2) {
        throw new CronError(`Campo ${label}: intervallo non valido "${rangePart}"`);
      }
      const first = Number(bounds[0]);
      if (!Number.isInteger(first)) {
        throw new CronError(`Campo ${label}: "${bounds[0] ?? ''}" non è un numero`);
      }
      start = first;
      end = bounds.length === 2 ? Number(bounds[1]) : stepPart === undefined ? first : maximum;
      if (!Number.isInteger(end)) {
        throw new CronError(`Campo ${label}: "${bounds[1] ?? ''}" non è un numero`);
      }
      if (end < start) {
        throw new CronError(
          `Campo ${label}: l’intervallo ${start}-${end} è al contrario (gli intervalli non scavalcano la mezzanotte)`,
        );
      }
    }

    if (start < minimum || end > maximum) {
      throw new CronError(
        `Campo ${label}: i valori devono stare tra ${minimum} e ${maximum} (ricevuto "${item}")`,
      );
    }

    if (rangePart !== '*') restricted = true;
    for (let value = start; value <= end; value += step) {
      // 7 e 0 sono la stessa domenica: la normalizzazione avviene una volta sola
      // così il confronto con `Date.getDay()` resta banale.
      values.add(index === 4 && value === 7 ? 0 : value);
    }
  }

  if (values.size === 0) {
    throw new CronError(`Campo ${label}: nessun valore valido in "${raw}"`);
  }

  if (index === 0) parsed.minutes = values;
  else if (index === 1) parsed.hours = values;
  else if (index === 2) parsed.daysOfMonth = values;
  else if (index === 3) parsed.months = values;
  else parsed.daysOfWeek = values;

  return restricted;
}

/** Parsa un'espressione a 5 campi. Lancia `CronError` con un messaggio leggibile. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `L’espressione cron deve avere 5 campi (minuto ora giorno mese giorno-settimana), ricevuti ${fields.length}`,
    );
  }

  const parsed = {
    minutes: new Set<number>(),
    hours: new Set<number>(),
    daysOfMonth: new Set<number>(),
    months: new Set<number>(),
    daysOfWeek: new Set<number>(),
  };

  const restricted = fields.map((field, index) => parseField(field ?? '', index, parsed));

  return {
    expression: expression.trim(),
    minutes: parsed.minutes,
    hours: parsed.hours,
    daysOfMonth: parsed.daysOfMonth,
    months: parsed.months,
    daysOfWeek: parsed.daysOfWeek,
    dayOfMonthRestricted: restricted[2] ?? false,
    dayOfWeekRestricted: restricted[4] ?? false,
  };
}

/** Vero quando l'espressione è valida; usato da Zod e dal caricamento cache. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Vero se il minuto di `at` (ora locale del server) soddisfa l'espressione.
 * La granularità è il minuto: il motore valuta una volta al minuto, quindi lo
 * stesso minuto non può scattare due volte.
 */
export function matchesCron(cron: ParsedCron, at: Date): boolean {
  if (!cron.minutes.has(at.getMinutes())) return false;
  if (!cron.hours.has(at.getHours())) return false;
  if (!cron.months.has(at.getMonth() + 1)) return false;

  const dayOfMonth = cron.daysOfMonth.has(at.getDate());
  const dayOfWeek = cron.daysOfWeek.has(at.getDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) {
    return dayOfMonth || dayOfWeek;
  }
  return dayOfMonth && dayOfWeek;
}

/** Minuti dalla mezzanotte nell'ora locale del server. */
export function localMinuteOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * Chiave del minuto locale (`YYYY-MM-DDTHH:MM`): il motore la usa per non
 * rieseguire due volte la stessa regola dentro lo stesso minuto, anche se il
 * tick viene invocato più volte (test manuali, riavvio della cache).
 */
export function minuteStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
