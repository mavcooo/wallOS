import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { panelHostname, resolveBrokerDefaults, type BrokerEnv } from '@/config/app.config';

/**
 * Default di fabbrica, usati quando l'ambiente non dice nulla. L'host è quello
 * del pannello (`window.location.hostname`, in jsdom `localhost`): niente IP
 * cablati, che su un tablet in LAN puntavano a una macchina inesistente.
 */
const FACTORY_DEFAULTS = {
  host: 'localhost',
  port: 9001,
  protocol: 'ws',
  path: '/mqtt',
  username: '',
  password: '',
  baseTopic: '',
  demoMode: true,
} as const;

const PUBLIC_ENV_KEYS = [
  'VITE_MQTT_DISCOVERY_PREFIXES',
  'VITE_MQTT_HOST',
  'VITE_MQTT_PORT',
  'VITE_MQTT_PROTOCOL',
  'VITE_MQTT_PATH',
  'VITE_MQTT_BASE_TOPIC',
] as const;

const FULL_ENV: BrokerEnv = {
  VITE_MQTT_HOST: 'broker.casa.lan',
  VITE_MQTT_PORT: '1884',
  VITE_MQTT_PROTOCOL: 'wss',
  VITE_MQTT_PATH: '/mqtt2',
  VITE_MQTT_BASE_TOPIC: 'casa/piano1',
};

describe('resolveBrokerDefaults', () => {
  it('senza variabili restituisce i default di fabbrica e resta in demo', () => {
    expect(resolveBrokerDefaults({})).toEqual(FACTORY_DEFAULTS);
  });

  it('usa ogni variabile pubblica presente e spegne la demo', () => {
    expect(resolveBrokerDefaults(FULL_ENV)).toEqual({
      host: 'broker.casa.lan',
      port: 1884,
      protocol: 'wss',
      path: '/mqtt2',
      // Le credenziali non arrivano mai dall'ambiente di build.
      username: '',
      password: '',
      baseTopic: 'casa/piano1',
      demoMode: false,
    });
  });

  it('accetta una configurazione parziale: il resto resta ai default', () => {
    const defaults = resolveBrokerDefaults({ VITE_MQTT_HOST: '10.0.0.5' });

    expect(defaults).toEqual({ ...FACTORY_DEFAULTS, host: '10.0.0.5', demoMode: false });
  });

  it.each(['abc', '0', '-1', '65536', '8080.5', 'NaN'])(
    'ignora la porta non valida %s e tiene 9001',
    (port) => {
      expect(resolveBrokerDefaults({ VITE_MQTT_PORT: port }).port).toBe(9001);
    },
  );

  it('accetta i limiti di porta validi', () => {
    expect(resolveBrokerDefaults({ VITE_MQTT_PORT: '1' }).port).toBe(1);
    expect(resolveBrokerDefaults({ VITE_MQTT_PORT: '65535' }).port).toBe(65_535);
  });

  it('normalizza il protocollo e ignora i valori non supportati', () => {
    expect(resolveBrokerDefaults({ VITE_MQTT_PROTOCOL: 'WSS' }).protocol).toBe('wss');
    expect(resolveBrokerDefaults({ VITE_MQTT_PROTOCOL: ' ws ' }).protocol).toBe('ws');
    expect(resolveBrokerDefaults({ VITE_MQTT_PROTOCOL: 'http' }).protocol).toBe('ws');
  });

  it('ignora eventuali credenziali rimaste nell’ambiente (non più esposte)', () => {
    // `resolveBrokerDefaults` accetta solo il sottoinsieme pubblico: un
    // `MQTT_PASSWORD` legacy non può rientrare nel bundle né nei default.
    const legacy = { MQTT_USERNAME: 'wallos_kiosk', MQTT_PASSWORD: 'segreta' } as BrokerEnv;
    expect(resolveBrokerDefaults(legacy)).toMatchObject({ username: '', password: '' });
  });

  it('tratta stringhe vuote o di soli spazi come variabili assenti', () => {
    const defaults = resolveBrokerDefaults({
      VITE_MQTT_HOST: '   ',
      VITE_MQTT_PORT: ' ',
      VITE_MQTT_PROTOCOL: '',
      VITE_MQTT_PATH: '  ',
      VITE_MQTT_BASE_TOPIC: '',
    });

    expect(defaults).toEqual(FACTORY_DEFAULTS);
  });

  it('ritaglia gli spazi attorno ai valori', () => {
    expect(
      resolveBrokerDefaults({ VITE_MQTT_HOST: ' broker.casa.lan ', VITE_MQTT_PATH: ' /mqtt ' }),
    ).toMatchObject(
      { host: 'broker.casa.lan', path: '/mqtt' },
    );
  });

  it('senza VITE_MQTT_HOST usa l’host del pannello, non un IP cablato', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, hostname: '192.168.0.101' },
    });

    try {
      expect(panelHostname()).toBe('192.168.0.101');
      expect(resolveBrokerDefaults({})).toMatchObject({
        host: '192.168.0.101',
        demoMode: true,
      });
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('DEFAULT_BROKER', () => {
  // Una `VITE_MQTT_*` già presente nella shell (o nel secret store della CI)
  // non deve cambiare l'esito dei singoli casi.
  beforeEach(() => {
    for (const key of PUBLIC_ENV_KEYS) vi.stubEnv(key, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('deriva da import.meta.env a ogni caricamento del modulo', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_MQTT_HOST', 'env.casa.lan');
    vi.stubEnv('VITE_MQTT_PORT', '9005');

    const { DEFAULT_BROKER } = await import('@/config/app.config');

    expect(DEFAULT_BROKER).toMatchObject({
      host: 'env.casa.lan',
      port: 9005,
      username: '',
      password: '',
      demoMode: false,
      keepAlive: 30,
      cleanSession: true,
    });
    expect(DEFAULT_BROKER.clientId).toMatch(/^domus-kiosk-[a-z0-9]{6}$/);
  });

  it('non legge credenziali MQTT_* o VITE_* sensibili', async () => {
    vi.resetModules();
    vi.stubEnv('MQTT_USERNAME', 'wallos_kiosk');
    vi.stubEnv('MQTT_PASSWORD', 'segreta');
    vi.stubEnv('VITE_MQTT_USERNAME', 'wallos_kiosk');
    vi.stubEnv('VITE_MQTT_PASSWORD', 'segreta');

    const { DEFAULT_BROKER } = await import('@/config/app.config');

    expect(DEFAULT_BROKER.username).toBe('');
    expect(DEFAULT_BROKER.password).toBe('');
  });

  it('senza ambiente resta in demo sui valori di fabbrica', async () => {
    vi.resetModules();

    const { DEFAULT_BROKER } = await import('@/config/app.config');

    expect(DEFAULT_BROKER).toMatchObject({ host: 'localhost', port: 9001, demoMode: true });
  });

  it('senza VITE_MQTT_DISCOVERY_PREFIXES ascolta il prefisso standard', async () => {
    vi.resetModules();

    const { DISCOVERY } = await import('@/config/app.config');

    expect(DISCOVERY.prefixes).toEqual(['homeassistant']);
  });

  it('legge i prefissi di discovery da ambiente, ignorando voci vuote', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_MQTT_DISCOVERY_PREFIXES', ' homeassistant , zigbee2mqtt ,, ');

    const { DISCOVERY } = await import('@/config/app.config');

    expect(DISCOVERY.prefixes).toEqual(['homeassistant', 'zigbee2mqtt']);
  });

  it('una variabile vuota ricade sul prefisso standard', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_MQTT_DISCOVERY_PREFIXES', '');

    const { DISCOVERY } = await import('@/config/app.config');

    expect(DISCOVERY.prefixes).toEqual(['homeassistant']);
  });
});
