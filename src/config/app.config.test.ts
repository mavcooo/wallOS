import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveBrokerDefaults, type BrokerEnv } from '@/config/app.config';

/** Default di fabbrica, usati quando l'ambiente non dice nulla. */
const FACTORY_DEFAULTS = {
  host: '192.168.1.10',
  port: 9001,
  protocol: 'ws',
  path: '/mqtt',
  username: '',
  password: '',
  baseTopic: '',
  demoMode: true,
} as const;

const MQTT_KEYS = [
  'MQTT_DISCOVERY_PREFIXES',
  'MQTT_HOST',
  'MQTT_PORT',
  'MQTT_PROTOCOL',
  'MQTT_PATH',
  'MQTT_BASE_TOPIC',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
] as const;

const FULL_ENV: BrokerEnv = {
  MQTT_HOST: 'broker.casa.lan',
  MQTT_PORT: '1884',
  MQTT_PROTOCOL: 'wss',
  MQTT_PATH: '/mqtt2',
  MQTT_BASE_TOPIC: 'casa/piano1',
  MQTT_USERNAME: 'kiosk',
  MQTT_PASSWORD: 'segreta',
};

describe('resolveBrokerDefaults', () => {
  it('senza variabili restituisce i default di fabbrica e resta in demo', () => {
    expect(resolveBrokerDefaults({})).toEqual(FACTORY_DEFAULTS);
  });

  it('usa ogni variabile presente e spegne la demo', () => {
    expect(resolveBrokerDefaults(FULL_ENV)).toEqual({
      host: 'broker.casa.lan',
      port: 1884,
      protocol: 'wss',
      path: '/mqtt2',
      username: 'kiosk',
      password: 'segreta',
      baseTopic: 'casa/piano1',
      demoMode: false,
    });
  });

  it('accetta una configurazione parziale: il resto resta ai default', () => {
    const defaults = resolveBrokerDefaults({ MQTT_HOST: '10.0.0.5' });

    expect(defaults).toEqual({ ...FACTORY_DEFAULTS, host: '10.0.0.5', demoMode: false });
  });

  it.each(['abc', '0', '-1', '65536', '8080.5', 'NaN'])(
    'ignora la porta non valida %s e tiene 9001',
    (port) => {
      expect(resolveBrokerDefaults({ MQTT_PORT: port }).port).toBe(9001);
    },
  );

  it('accetta i limiti di porta validi', () => {
    expect(resolveBrokerDefaults({ MQTT_PORT: '1' }).port).toBe(1);
    expect(resolveBrokerDefaults({ MQTT_PORT: '65535' }).port).toBe(65_535);
  });

  it('normalizza il protocollo e ignora i valori non supportati', () => {
    expect(resolveBrokerDefaults({ MQTT_PROTOCOL: 'WSS' }).protocol).toBe('wss');
    expect(resolveBrokerDefaults({ MQTT_PROTOCOL: ' ws ' }).protocol).toBe('ws');
    expect(resolveBrokerDefaults({ MQTT_PROTOCOL: 'http' }).protocol).toBe('ws');
  });

  it('tratta stringhe vuote o di soli spazi come variabili assenti', () => {
    const defaults = resolveBrokerDefaults({
      MQTT_HOST: '   ',
      MQTT_PORT: ' ',
      MQTT_PROTOCOL: '',
      MQTT_USERNAME: '',
      MQTT_PASSWORD: '',
      MQTT_PATH: '  ',
      MQTT_BASE_TOPIC: '',
    });

    expect(defaults).toEqual(FACTORY_DEFAULTS);
  });

  it('ritaglia gli spazi attorno ai valori', () => {
    expect(resolveBrokerDefaults({ MQTT_HOST: ' broker.casa.lan ', MQTT_PATH: ' /mqtt ' })).toMatchObject(
      { host: 'broker.casa.lan', path: '/mqtt' },
    );
  });
});

describe('DEFAULT_BROKER', () => {
  // Un `MQTT_*` già presente nella shell (o nel secret store della CI) non deve
  // cambiare l'esito dei singoli casi.
  beforeEach(() => {
    for (const key of MQTT_KEYS) vi.stubEnv(key, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('deriva da import.meta.env a ogni caricamento del modulo', async () => {
    vi.resetModules();
    vi.stubEnv('MQTT_HOST', 'env.casa.lan');
    vi.stubEnv('MQTT_PORT', '9005');
    vi.stubEnv('MQTT_USERNAME', 'kiosk');

    const { DEFAULT_BROKER } = await import('@/config/app.config');

    expect(DEFAULT_BROKER).toMatchObject({
      host: 'env.casa.lan',
      port: 9005,
      username: 'kiosk',
      demoMode: false,
      keepAlive: 30,
      cleanSession: true,
    });
    expect(DEFAULT_BROKER.clientId).toMatch(/^domus-kiosk-[a-z0-9]{6}$/);
  });

  it('senza ambiente resta in demo sui valori di fabbrica', async () => {
    vi.resetModules();

    const { DEFAULT_BROKER } = await import('@/config/app.config');

    expect(DEFAULT_BROKER).toMatchObject({ host: '192.168.1.10', port: 9001, demoMode: true });
  });

  it('senza MQTT_DISCOVERY_PREFIXES ascolta il prefisso standard', async () => {
    vi.resetModules();

    const { DISCOVERY } = await import('@/config/app.config');

    expect(DISCOVERY.prefixes).toEqual(['homeassistant']);
  });

  it('legge i prefissi di discovery da ambiente, ignorando voci vuote', async () => {
    vi.resetModules();
    vi.stubEnv('MQTT_DISCOVERY_PREFIXES', ' homeassistant , zigbee2mqtt ,, ');

    const { DISCOVERY } = await import('@/config/app.config');

    expect(DISCOVERY.prefixes).toEqual(['homeassistant', 'zigbee2mqtt']);
  });

  it('una variabile vuota ricade sul prefisso standard', async () => {
    vi.resetModules();
    vi.stubEnv('MQTT_DISCOVERY_PREFIXES', '');

    const { DISCOVERY } = await import('@/config/app.config');

    expect(DISCOVERY.prefixes).toEqual(['homeassistant']);
  });
});
