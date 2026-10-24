import type {
  DecodedState,
  Device,
  DeviceMetadata,
  DeviceRealtimeState,
} from '@/types/device';

/**
 * Ponte tra topologia (TanStack Query) e telemetria (Zustand).
 *
 * - `seedDeviceRealtimeState` crea la riga realtime di un device appena noto.
 *   Lo stato iniziale è l'istantanea restituita dal server; da quel momento il
 *   broker è l'unica fonte di verità.
 * - `combineDevice` ricostruisce il view-model tipizzato che i widget ricevono
 *   in props, senza copiare metadati nello store.
 * - `mergeDecodedRealtime` applica una patch decodificata alla sola riga del
 *   device: immutabile, O(1), nessuna scansione della mappa.
 */

export function seedDeviceRealtimeState(device: Device): DeviceRealtimeState {
  return {
    id: device.id,
    kind: device.kind,
    state: device.state,
    availability: device.availability ?? 'unknown',
    lastSeen: device.lastSeen,
    favorite: device.favorite,
    isOptimistic: false,
    lastUpdated: Date.now(),
  } as DeviceRealtimeState;
}

/** Il view-model esiste solo quando metadati e riga realtime sono entrambi noti. */
export function combineDevice(
  metadata: DeviceMetadata | undefined,
  realtime: DeviceRealtimeState | undefined,
): Device | null {
  if (!metadata || !realtime || metadata.kind !== realtime.kind) return null;
  return {
    ...metadata,
    state: realtime.state,
    availability: realtime.availability,
    lastSeen: realtime.lastSeen,
    favorite: realtime.favorite,
  } as Device;
}

/**
 * Fusione immutabile della patch nella riga realtime.
 *
 * `null` significa "nessuna modifica": device assente o patch di un altro tipo
 * (un retained vecchio non deve sovrascrivere un device riconfigurato).
 */
export function mergeDecodedRealtime(
  current: DeviceRealtimeState | undefined,
  decoded: DecodedState,
): DeviceRealtimeState | null {
  if (!current || current.kind !== decoded.kind) return null;

  const state = { ...current.state, ...decoded.state } as DeviceRealtimeState['state'];
  return {
    ...current,
    state,
    availability: 'online',
    isOptimistic: false,
    lastUpdated: Date.now(),
  } as DeviceRealtimeState;
}
