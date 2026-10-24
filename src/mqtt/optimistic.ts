import type { ControlAction, DecodedState, DeviceRealtimeState } from '@/types/device';

/**
 * Gli stati sono union di interfacce senza index signature: per leggerli come
 * mappa chiave/valore serve passare da `unknown`.
 */
function asRecord(state: DecodedState['state']): Record<string, unknown> {
  return state as unknown as Record<string, unknown>;
}

/**
 * Patch ottimistica applicata subito dopo il publish: la UI risponde in <16ms
 * e viene riconciliata dal messaggio `stat` reale quando arriva dal broker.
 */
export function optimisticState(
  device: DeviceRealtimeState,
  action: ControlAction,
): DecodedState | null {
  switch (device.kind) {
    case 'light':
      switch (action.type) {
        case 'power':
          return { kind: 'light', state: { on: action.on } };
        case 'brightness':
          return { kind: 'light', state: { on: action.brightness > 0, brightness: action.brightness } };
        case 'colorTemp':
          return { kind: 'light', state: { colorTemp: action.kelvin } };
        default:
          return null;
      }
    case 'climate':
      switch (action.type) {
        case 'targetTemp':
          return { kind: 'climate', state: { targetTemp: action.targetTemp } };
        case 'climateMode':
          return {
            kind: 'climate',
            state: { mode: action.mode, action: action.mode === 'off' ? 'idle' : device.state.action },
          };
        case 'fanSpeed':
          return { kind: 'climate', state: { fanSpeed: action.fanSpeed } };
        case 'swing':
          return { kind: 'climate', state: { swing: action.swing } };
        default:
          return null;
      }
    case 'power':
      return action.type === 'power' ? { kind: 'power', state: { on: action.on } } : null;
    case 'media':
      switch (action.type) {
        case 'power':
          return { kind: 'media', state: { power: action.on } };
        case 'volume':
          return { kind: 'media', state: { volume: action.volume } };
        case 'source':
          return { kind: 'media', state: { source: action.source } };
        default:
          return null;
      }
    case 'sensor':
    case 'camera':
      return null;
  }
}

/**
 * Fotografa lo stato *reale* dei soli campi che la patch ottimistica toccherà.
 * Va chiamata prima di `applyDecoded`/`applyOptimistic`, così un TTL scaduto o
 * un publish fallito può ripristinare esattamente quei campi.
 */
export function captureRollback(
  device: DeviceRealtimeState,
  optimistic: DecodedState | null,
): DecodedState | null {
  if (!optimistic || optimistic.kind !== device.kind) return null;
  const expected = asRecord(optimistic.state);
  const current = asRecord(device.state);
  const previous: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    if (key in current) previous[key] = current[key];
  }
  return { kind: device.kind, state: previous } as unknown as DecodedState;
}

/**
 * Patch inversa da applicare al rollback. Ogni campo viene ripristinato solo se
 * la UI mostra ancora il valore ottimistico: un aggiornamento reale arrivato nel
 * frattempo (stat del broker, altro client) ha sempre la precedenza.
 */
export function rollbackState(
  device: DeviceRealtimeState,
  optimistic: DecodedState | null,
  previous: DecodedState | null,
): DecodedState | null {
  if (!optimistic || optimistic.kind !== device.kind) return null;
  if (!previous || previous.kind !== device.kind) return null;
  const expected = asRecord(optimistic.state);
  const before = asRecord(previous.state);
  const current = asRecord(device.state);
  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(expected)) {
    if (!(key in before) || !(key in current)) continue;
    if (current[key] === expected[key]) patch[key] = before[key];
  }

  if (Object.keys(patch).length === 0) return null;
  return { kind: device.kind, state: patch } as unknown as DecodedState;
}
