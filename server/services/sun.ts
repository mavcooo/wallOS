import type { SunEventName } from '../types.js';

/**
 * Alba e tramonto calcolati dall'ora locale del server, senza dipendenze e
 * senza tabelle: bastano latitudine e longitudine (le effemeridi solari sono
 * note da secoli, non serve un pacchetto npm per 20 righe di trigonometria).
 *
 * Si usa l'equazione del tramonto di NOAA/Wikipedia, con due convenzioni:
 *
 * - **rifrazione e semidiametro**: l'evento è il momento in cui il *lembo*
 *   superiore del disco solare tocca l'orizzonte, cioè 0,833° sotto l'asse
 *   geometrico — è l'ora che si legge sui calendari e sui siti meteo;
 * - **longitudine est positiva** (`12.4964` per Roma), coerente con `ATTR_*`
 *   del pannello e con le mappe.
 *
 * Precisione: circa un minuto, ampiamente sotto la granularità del motore
 * (che valuta una volta al minuto). Nei giorni di sole perenne o notte polare
 * l'evento non esiste: `null`, e la regola resta inerte invece di scattare a
 * un orario inventato.
 */

const RAD = Math.PI / 180;
const OBLIQUITY = 23.44 * RAD;
/** Altezza del centro del Sole all'evento: rifrazione + semidiametro. */
const HORIZON = -0.833 * RAD;
/** Mezzogiorno del 1 gennaio 2000 (J2000), in giorni giuliani. */
const J2000 = 2451545;
/** Giorni giuliani tra l'epoca Unix e J2000. */
const JULIAN_UNIX_EPOCH = 2440587.5;

/**
 * Giorni interi trascorsi dal 1 gennaio 2000 nel calendario locale: è la `n`
 * dell'equazione (il giorno 0 è J2000, cioè il 1 gennaio 2000 alle 12:00 UTC).
 * Conteggio intero e non frazionario: l'ora del transito la portano la
 * longitudine e l'equazione del tempo.
 */
function daysSinceJ2000(at: Date): number {
  const start = Date.UTC(2000, 0, 1);
  const current = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  return Math.round((current - start) / 86_400_000);
}

function julianDateToDate(julianDate: number): Date {
  return new Date((julianDate - JULIAN_UNIX_EPOCH) * 86_400_000);
}

export interface SunEventOptions {
  latitude: number;
  /** Gradi decimali, est positiva. */
  longitude: number;
  /** Data di riferimento: solo anno/mese/giorno locali contano. */
  at: Date;
}

/**
 * Istante UTC di alba o tramonto per il giorno locale di `at`.
 * `null` quando l'evento non esiste (latitudine polare) o i dati non sono validi.
 */
export function sunEvent(
  event: SunEventName,
  { latitude, longitude, at }: SunEventOptions,
): Date | null {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  const n = daysSinceJ2000(at);
  // Mezzogiorno solare medio, in giorni rispetto a J2000 (base 12:00 UTC).
  // 15° di longitudine est = un'ora *prima* in UTC, quindi si sottrae.
  const meanSolarNoon = n - longitude / 360;

  const meanAnomaly = (357.5291 + 0.98560028 * meanSolarNoon) % 360;
  const m = meanAnomaly * RAD;
  const equationOfCenter =
    1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
  const eclipticLongitude = (meanAnomaly + equationOfCenter + 180 + 102.9372) % 360;
  const lambda = eclipticLongitude * RAD;

  const solarTransit =
    J2000 +
    meanSolarNoon +
    0.0053 * Math.sin(m) -
    0.0069 * Math.sin(2 * lambda);

  const sinDeclination = Math.sin(lambda) * Math.sin(OBLIQUITY);
  const declination = Math.asin(sinDeclination);
  const phi = latitude * RAD;

  const cosHourAngle =
    (Math.sin(HORIZON) - Math.sin(phi) * sinDeclination) /
    (Math.cos(phi) * Math.cos(declination));

  // > 1: il Sole non sorge (notte polare). < -1: non tramonta (sole di mezzanotte).
  if (!Number.isFinite(cosHourAngle) || cosHourAngle > 1 || cosHourAngle < -1) {
    return null;
  }

  const hourAngle = (Math.acos(cosHourAngle) / RAD) / 360;
  const transit = event === 'sunrise' ? solarTransit - hourAngle : solarTransit + hourAngle;
  return julianDateToDate(transit);
}

/**
 * Minuti dalla mezzanotte **locale** dell'evento, già sfasato di
 * `offsetMinutes` (negativo = prima dell'effemeride, come chiede il pannello).
 * `null` se l'evento non esiste in quella data.
 */
export function sunEventLocalMinutes(
  event: SunEventName,
  options: SunEventOptions & { offsetMinutes?: number },
): number | null {
  const instant = sunEvent(event, options);
  if (!instant) return null;
  const shifted = new Date(instant.getTime() + (options.offsetMinutes ?? 0) * 60_000);
  return shifted.getHours() * 60 + shifted.getMinutes();
}
