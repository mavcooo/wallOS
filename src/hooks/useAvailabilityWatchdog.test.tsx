import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_STALE_TIMEOUT_MS,
  runAvailabilityWatchdog,
  staleTimeoutFor,
} from '@/hooks/useAvailabilityWatchdog';
import { useHomeStore } from '@/store/homeStore';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import type { DeviceRealtimeState } from '@/types/device';

const SENSOR = SEED_TOPOLOGY.devices.find((device) => device.kind === 'sensor');
if (!SENSOR) throw new Error('il seed deve contenere almeno un sensore');

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
  useHomeStore.getState().syncDeviceStates(SEED_TOPOLOGY.devices);
});

/** Riscrive la riga realtime con l'ultimo payload avvenuto `ageMs` fa. */
function age(deviceId: string, ageMs: number): void {
  const states = useHomeStore.getState().deviceStates;
  const row = states[deviceId];
  if (!row) throw new Error(`riga realtime mancante per ${deviceId}`);
  useHomeStore.setState({
    deviceStates: {
      ...states,
      [deviceId]: { ...row, lastUpdated: Date.now() - ageMs } as DeviceRealtimeState,
    },
  });
}

describe('staleTimeoutFor', () => {
  it('applica il default di 30 minuti ai sensori senza LWT', () => {
    expect(staleTimeoutFor(SENSOR)).toBe(DEFAULT_STALE_TIMEOUT_MS);
  });

  it('rispetta un timeout esplicito e ignora gli attuatori con LWT', () => {
    expect(staleTimeoutFor({ ...SENSOR, staleTimeoutMs: 90_000 })).toBe(90_000);
    const actuator = SEED_TOPOLOGY.devices.find(
      (device) => device.kind === 'light' && Boolean(device.topics.availability),
    );
    expect(actuator && staleTimeoutFor(actuator)).toBeNull();
  });
});

describe('runAvailabilityWatchdog', () => {
  it('marca stale il sensore silenzioso oltre la soglia', () => {
    age(SENSOR.id, DEFAULT_STALE_TIMEOUT_MS + 60_000);

    const marked = runAvailabilityWatchdog(SEED_TOPOLOGY.devices);

    const row = useHomeStore.getState().deviceStates[SENSOR.id];
    expect(marked).toContain(SENSOR.id);
    expect(row?.availability).toBe('stale');
    expect(row?.isAvailable).toBe(false);
    // Le metriche restano: la card mostra l'ultimo dato, ma non interagisce.
    expect(row?.state).toEqual(SENSOR.state);
  });

  it('lascia in pace i sensori che hanno appena trasmesso', () => {
    age(SENSOR.id, 60_000);

    expect(runAvailabilityWatchdog(SEED_TOPOLOGY.devices)).not.toContain(SENSOR.id);
    expect(useHomeStore.getState().deviceStates[SENSOR.id]?.isAvailable).toBe(true);
  });

  it('non degrada un offline dichiarato dal broker', () => {
    useHomeStore.getState().setAvailability(SENSOR.id, 'offline');
    age(SENSOR.id, DEFAULT_STALE_TIMEOUT_MS * 5);

    runAvailabilityWatchdog(SEED_TOPOLOGY.devices);

    expect(useHomeStore.getState().deviceStates[SENSOR.id]?.availability).toBe('offline');
  });

  it('una lettura valida ripristina subito la disponibilità', () => {
    age(SENSOR.id, DEFAULT_STALE_TIMEOUT_MS + 60_000);
    runAvailabilityWatchdog(SEED_TOPOLOGY.devices);
    expect(useHomeStore.getState().deviceStates[SENSOR.id]?.isAvailable).toBe(false);

    useHomeStore.getState().applyDecoded(SENSOR.id, { kind: 'sensor', state: { value: 21.4 } });

    const row = useHomeStore.getState().deviceStates[SENSOR.id];
    expect(row?.availability).toBe('online');
    expect(row?.isAvailable).toBe(true);
    expect(runAvailabilityWatchdog(SEED_TOPOLOGY.devices)).not.toContain(SENSOR.id);
  });
});
