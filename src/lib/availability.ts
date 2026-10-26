import type { DeviceMetadata } from '@/types/device';
import type { MqttAvailabilityState } from '@/types/mqtt';

/**
 * Interpretazione dei payload di disponibilità (LWT).
 *
 * Ogni ecosistema pubblica un formato diverso sullo stesso concetto:
 * - Zigbee2MQTT → `{"state":"online"}` (ma anche la stringa nuda, con
 *   `availability` annunciata via Home Assistant Discovery);
 * - Tasmota → `Online` / `Offline` su `tele/<device>/LWT`;
 * - Shelly Gen1 → `true` / `false` su `shellies/<device>/online`;
 * - Shelly Gen2/Plus → `true` / `false` / `online` / `offline` sul topic RPC.
 *
 * Il parser non conosce i vendor: normalizza il payload e, se il device
 * dichiara payload personalizzati (`availabilityPayloadOnline/Offline`,
 * `payload_available`/`payload_not_available` di HA Discovery), dà loro la
 * precedenza sul default.
 */

export interface AvailabilityPayloadOptions {
  payloadOnline?: string | undefined;
  payloadOffline?: string | undefined;
}

/** Valori riconosciuti quando il device non dichiara payload espliciti. */
const ONLINE_VALUES = new Set([
  'online',
  'true',
  '1',
  'on',
  'up',
  'connected',
  'available',
]);
const OFFLINE_VALUES = new Set([
  'offline',
  'false',
  '0',
  'off',
  'down',
  'disconnected',
  'unavailable',
]);

/** Chiavi che possono trasportare lo stato dentro un payload JSON. */
const STATE_KEYS = ['state', 'availability', 'online', 'status', 'connected', 'lwt'] as const;

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function classify(
  raw: unknown,
  options: AvailabilityPayloadOptions,
): MqttAvailabilityState | null {
  if (typeof raw === 'boolean') return raw ? 'online' : 'offline';
  if (typeof raw === 'number') return raw === 0 ? 'offline' : 'online';
  if (typeof raw !== 'string') return null;

  const token = normalizeToken(raw);
  if (!token) return null;

  const customOnline = options.payloadOnline ? normalizeToken(options.payloadOnline) : null;
  const customOffline = options.payloadOffline ? normalizeToken(options.payloadOffline) : null;
  if (customOnline && token === customOnline) return 'online';
  if (customOffline && token === customOffline) return 'offline';

  if (ONLINE_VALUES.has(token)) return 'online';
  if (OFFLINE_VALUES.has(token)) return 'offline';
  return null;
}

/**
 * `null` = payload non riconosciuto: il chiamante deve lasciare lo stato
 * precedente, così un retained vuoto o un messaggio di un altro vendor non
 * spegne un device per errore.
 */
export function parseAvailabilityPayload(
  payload: string,
  options: AvailabilityPayloadOptions = {},
): MqttAvailabilityState | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  // Payload JSON (Zigbee2MQTT, Shelly Gen2, HA): si cerca la prima chiave nota.
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        for (const key of STATE_KEYS) {
          if (key in record) {
            const state = classify(record[key], options);
            if (state) return state;
          }
        }
      }
    } catch {
      // Non è JSON valido: si prova comunque come stringa semplice.
    }
  }

  return classify(trimmed, options);
}

/** True quando il device ha almeno un topic LWT (dichiarato o scoperto). */
export function hasAvailabilityTopic(device: DeviceMetadata): boolean {
  if (device.topics.availability) return true;
  return (device.discovery?.availability.length ?? 0) > 0;
}

/**
 * Topic di availability con il payload atteso, nell'ordine in cui vanno
 * valutati: prima quello del seed (payload dedicati), poi gli annunci HA.
 */
export function availabilityChannels(
  device: DeviceMetadata,
): { topic: string; payloadOnline?: string; payloadOffline?: string }[] {
  const channels: { topic: string; payloadOnline?: string; payloadOffline?: string }[] = [];
  if (device.topics.availability) {
    channels.push({
      topic: device.topics.availability,
      ...(device.availabilityPayloadOnline
        ? { payloadOnline: device.availabilityPayloadOnline }
        : {}),
      ...(device.availabilityPayloadOffline
        ? { payloadOffline: device.availabilityPayloadOffline }
        : {}),
    });
  }
  for (const entry of device.discovery?.availability ?? []) {
    channels.push({
      topic: entry.topic,
      ...(entry.payloadAvailable ? { payloadOnline: entry.payloadAvailable } : {}),
      ...(entry.payloadNotAvailable ? { payloadOffline: entry.payloadNotAvailable } : {}),
    });
  }
  return channels;
}
