import type { DecodedState, Device, DeviceKind, SensorType } from '@/types/device';

/**
 * Policy di classificazione delle patch MQTT.
 *
 * Regola d'oro: solo i campi esplicitamente elencati in `TELEMETRY_FIELDS`
 * possono essere ritardati. Tutto il resto (on/off, mode, allarmi, contatti,
 * comandi manuali, campi sconosciuti) è critico e bypassa il buffer.
 * Una allowlist è più sicura di una deny-list: un nuovo campo firmware non
 * finisce mai per errore in un percorso a bassa priorità.
 */

const EMPTY_FIELDS: ReadonlySet<string> = new Set<string>();

/** Sensori il cui valore numerico è telemetria continua; gli altri sono eventi. */
const CONTINUOUS_SENSOR_TYPES: ReadonlySet<SensorType> = new Set<SensorType>([
  'temperature',
  'humidity',
  'co2',
  'illuminance',
]);

const TELEMETRY_FIELDS: Record<DeviceKind, readonly string[]> = {
  light: [],
  climate: ['currentTemp', 'humidity'],
  power: ['watts', 'voltage', 'current', 'energyTodayKwh', 'energyTotalKwh'],
  media: [],
  sensor: ['value'],
};

const FIELD_SETS: Record<DeviceKind, ReadonlySet<string>> = {
  light: EMPTY_FIELDS,
  climate: new Set(TELEMETRY_FIELDS.climate),
  power: new Set(TELEMETRY_FIELDS.power),
  media: EMPTY_FIELDS,
  sensor: new Set(TELEMETRY_FIELDS.sensor),
};

/** Campi di un device che possono essere accumulati e applicati in differita. */
export function telemetryFieldsFor(device: Device): ReadonlySet<string> {
  if (device.kind === 'sensor' && !CONTINUOUS_SENSOR_TYPES.has(device.state.type)) {
    return EMPTY_FIELDS;
  }
  return FIELD_SETS[device.kind];
}

export interface SplitDecodedState {
  critical: DecodedState | null;
  telemetry: DecodedState | null;
}

/**
 * Un singolo payload può contenere sia un cambio di stato sia telemetria
 * (es. Zigbee2MQTT pubblica `state` + `power` insieme): lo split permette al
 * cambio di stato di partire subito senza perdere il campione di potenza.
 */
export function splitDecoded(device: Device, decoded: DecodedState): SplitDecodedState {
  if (device.kind !== decoded.kind) return { critical: null, telemetry: null };

  const telemetryFields = telemetryFieldsFor(device);
  if (telemetryFields.size === 0) return { critical: decoded, telemetry: null };

  let critical: Record<string, unknown> | null = null;
  let telemetry: Record<string, unknown> | null = null;

  for (const [field, value] of Object.entries(decoded.state)) {
    if (value === undefined) continue;
    if (telemetryFields.has(field)) {
      telemetry ??= {};
      telemetry[field] = value;
    } else {
      critical ??= {};
      critical[field] = value;
    }
  }

  return {
    critical: critical ? asDecoded(decoded.kind, critical) : null,
    telemetry: telemetry ? asDecoded(decoded.kind, telemetry) : null,
  };
}

/** Merge di due patch dello stesso device; i campi di `patch` vincono sempre. */
export function mergeDecodedState(
  base: DecodedState | null,
  patch: DecodedState,
): DecodedState {
  if (!base || base.kind !== patch.kind) return patch;
  return asDecoded(base.kind, {
    ...(base.state as Record<string, unknown>),
    ...(patch.state as Record<string, unknown>),
  });
}

/** True se la patch non cambierebbe nulla rispetto allo stato già nello store. */
export function isNoOp(device: Device, patch: DecodedState): boolean {
  if (device.kind !== patch.kind) return true;
  const committed = device.state as unknown as Record<string, unknown>;
  return Object.entries(patch.state).every(([field, value]) => Object.is(committed[field], value));
}

/**
 * Una variazione è "significativa" se supera la soglia relativa configurata
 * (default 2%) e un pavimento assoluto per unità di misura. Le variazioni
 * minime restano nel buffer fino alla scadenza della finestra e non producono
 * un render anticipato.
 */
export function isSignificantChange(device: Device, patch: DecodedState, ratio: number): boolean {
  if (device.kind !== patch.kind) return false;
  const committed = device.state as unknown as Record<string, unknown>;

  for (const [field, next] of Object.entries(patch.state)) {
    if (typeof next !== 'number' || !Number.isFinite(next)) continue;
    const rawPrevious = committed[field];
    const previous = typeof rawPrevious === 'number' ? rawPrevious : 0;
    const delta = Math.abs(next - previous);
    if (delta === 0) continue;
    const threshold = Math.max(absoluteFloor(device, field), Math.abs(previous) * ratio);
    if (delta >= threshold) return true;
  }
  return false;
}

/** Pavimento anti-flapping per unità: evita flush immediati su rumore di fondo. */
function absoluteFloor(device: Device, field: string): number {
  switch (device.kind) {
    case 'power':
      switch (field) {
        case 'watts':
          return 5;
        case 'voltage':
          return 1;
        case 'current':
          return 0.05;
        default:
          // kWh cumulati: piccole crescite non devono anticipare il flush.
          return 0.005;
      }
    case 'climate':
      return field === 'humidity' ? 1 : 0.2;
    case 'sensor':
      switch (device.state.type) {
        case 'co2':
          return 20;
        case 'illuminance':
          return 10;
        case 'humidity':
          return 1;
        default:
          return 0.2;
      }
    default:
      return 0;
  }
}

/**
 * I campi sono già tipizzati dall'union `DecodedState`; il cast è confinato
 * qui perché la costruzione dinamica di `Partial<...>` non è esprimibile
 * senza indicizzare l'union.
 */
function asDecoded(kind: DeviceKind, state: Record<string, unknown>): DecodedState {
  return { kind, state } as unknown as DecodedState;
}
