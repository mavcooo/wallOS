import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBrowserStorage } from '@/test/browserEnv';
import type { BrokerSettings } from '@/types/mqtt';

const STORAGE_KEY = 'domus-kiosk-store';

const MQTT_KEYS = [
  'MQTT_HOST',
  'MQTT_PORT',
  'MQTT_PROTOCOL',
  'MQTT_PATH',
  'MQTT_BASE_TOPIC',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
] as const;

type MqttKey = (typeof MQTT_KEYS)[number];

beforeEach(() => {
  resetBrowserStorage();
  // Un `MQTT_*` già presente nella shell non deve influenzare i singoli casi.
  for (const key of MQTT_KEYS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Carica lo store da zero: moduli azzerati (così `DEFAULT_BROKER` viene
 * ricalcolato) e persist già scritto prima della creazione, perché zustand
 * idrata in modo sincrono all'import.
 */
async function loadStore(
  env: Partial<Record<MqttKey, string>> = {},
  saved?: Partial<BrokerSettings>,
) {
  vi.resetModules();
  for (const key of MQTT_KEYS) vi.stubEnv(key, '');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  if (saved) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { broker: saved }, version: 1 }));
  }

  const { useHomeStore } = await import('@/store/homeStore');
  return useHomeStore;
}

describe('broker: ambiente e persist', () => {
  it('senza persist e senza ambiente usa i default di fabbrica', async () => {
    const store = await loadStore();

    expect(store.getState().broker).toMatchObject({
      host: '192.168.1.10',
      port: 9001,
      protocol: 'ws',
      demoMode: true,
    });
  });

  it("senza persist applica l'ambiente", async () => {
    const store = await loadStore({
      MQTT_HOST: 'env.casa.lan',
      MQTT_PORT: '1884',
      MQTT_USERNAME: 'kiosk',
      MQTT_PASSWORD: 'segreta',
      MQTT_BASE_TOPIC: 'casa/piano1',
    });

    expect(store.getState().broker).toMatchObject({
      host: 'env.casa.lan',
      port: 1884,
      username: 'kiosk',
      password: 'segreta',
      baseTopic: 'casa/piano1',
      demoMode: false,
    });
  });

  it('il broker salvato vince campo per campo sui default di ambiente', async () => {
    const store = await loadStore(
      { MQTT_HOST: 'env.casa.lan', MQTT_PORT: '1884', MQTT_USERNAME: 'kiosk' },
      { host: 'salvato.casa.lan', port: 8080 },
    );

    expect(store.getState().broker).toMatchObject({
      // salvato: ha la precedenza
      host: 'salvato.casa.lan',
      port: 8080,
      // non salvato: resta il valore dell'ambiente
      username: 'kiosk',
      protocol: 'ws',
      demoMode: false,
    });
  });

  it('la modalità demo salvata vince sui default di ambiente', async () => {
    const store = await loadStore(
      { MQTT_HOST: 'env.casa.lan', MQTT_PORT: '1884' },
      { demoMode: true },
    );

    expect(store.getState().broker).toMatchObject({
      host: 'env.casa.lan',
      port: 1884,
      demoMode: true,
    });
  });

  it('espone i default della protezione burn-in', async () => {
    const store = await loadStore();

    expect(store.getState().burnIn).toEqual({
      mode: 'screensaver-float',
      shiftIntervalMs: 60_000,
      dimClockOpacity: 0.3,
    });
  });

  it('normalizza e persiste le impostazioni burn-in', async () => {
    const store = await loadStore();

    store.getState().setBurnInSettings({ mode: 'subtle-shift', shiftIntervalMs: 1, dimClockOpacity: 0.9 });

    expect(store.getState().burnIn).toEqual({
      mode: 'subtle-shift',
      shiftIntervalMs: 5_000,
      dimClockOpacity: 0.6,
    });

    const reloaded = await loadStore();
    expect(reloaded.getState().burnIn).toEqual({
      mode: 'subtle-shift',
      shiftIntervalMs: 5_000,
      dimClockOpacity: 0.6,
    });
  });

  it('quello che le Impostazioni salvano è quello che il kiosk rilegge', async () => {
    const store = await loadStore({ MQTT_HOST: 'env.casa.lan' });

    store.getState().updateBroker({ host: 'salvato.casa.lan', port: 9002, password: 'p4ss' });

    // Secondo avvio: stesso persist, moduli ricreati da capo.
    const reloaded = await loadStore({ MQTT_HOST: 'env.casa.lan' });

    expect(reloaded.getState().broker).toMatchObject({
      host: 'salvato.casa.lan',
      port: 9002,
      password: 'p4ss',
      demoMode: false,
    });
  });
});
