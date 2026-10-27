import { describe, expect, it } from 'vitest';

import {
  BATTERY_TELEMETRY_PUBLISH,
  batteryBand,
  batteryTelemetryPayload,
  batteryTelemetrySignature,
  kioskBatteryTopic,
  serializeBatteryTelemetry,
} from '@/services/kioskTelemetry';

describe('kioskTelemetry · topic', () => {
  it('costruisce il topic del pannello sotto il prefisso della casa', () => {
    expect(kioskBatteryTopic('tablet_ingresso')).toBe('wallos/kiosk/tablet_ingresso/battery');
    expect(kioskBatteryTopic('kiosk_5f0f2c1e')).toBe('wallos/kiosk/kiosk_5f0f2c1e/battery');
  });
});

describe('kioskTelemetry · payload', () => {
  it('normalizza il livello a un intero 0-100', () => {
    expect(batteryTelemetryPayload('tablet_ingresso', { level: 79.6, charging: true }).level).toBe(
      80,
    );
    expect(batteryTelemetryPayload('tablet_ingresso', { level: 104, charging: false }).level).toBe(
      100,
    );
    expect(batteryTelemetryPayload('tablet_ingresso', { level: -3, charging: false }).level).toBe(0);
  });

  it('produce il payload atteso dalla presa smart alle soglie 80% e 20%', () => {
    const charging = batteryTelemetryPayload(
      'tablet_ingresso',
      { level: 80, charging: true },
      1_730_000_000_000,
    );
    expect(charging).toEqual({
      kioskId: 'tablet_ingresso',
      level: 80,
      charging: true,
      timestamp: 1_730_000_000_000,
    });

    const discharging = batteryTelemetryPayload('tablet_ingresso', {
      level: 20,
      charging: false,
    });
    expect(discharging.level).toBe(20);
    expect(discharging.charging).toBe(false);
    expect(typeof discharging.timestamp).toBe('number');
  });

  it('serializza in JSON leggibile da un consumatore esterno', () => {
    const payload = batteryTelemetryPayload('pannello_cucina', { level: 55, charging: true }, 1);

    expect(JSON.parse(serializeBatteryTelemetry(payload))).toEqual({
      kioskId: 'pannello_cucina',
      level: 55,
      charging: true,
      timestamp: 1,
    });
  });

  it('pubblica con QoS 1 e retain: l’ultimo valore resta sul broker', () => {
    expect(BATTERY_TELEMETRY_PUBLISH).toEqual({ qos: 1, retain: true });
  });
});

describe('kioskTelemetry · firma del campione', () => {
  it('ignora il timestamp ma distingue livello e stato di carica', () => {
    expect(batteryTelemetrySignature({ level: 80, charging: true })).toBe(
      batteryTelemetrySignature({ level: 80.2, charging: true }),
    );
    expect(batteryTelemetrySignature({ level: 80, charging: true })).not.toBe(
      batteryTelemetrySignature({ level: 80, charging: false }),
    );
    expect(batteryTelemetrySignature({ level: 80, charging: false })).not.toBe(
      batteryTelemetrySignature({ level: 79, charging: false }),
    );
  });
});

describe('kioskTelemetry · fascia di protezione', () => {
  it('considera ottimale la banda 20-80% inclusa', () => {
    expect(batteryBand(20)).toBe('ok');
    expect(batteryBand(50)).toBe('ok');
    expect(batteryBand(80)).toBe('ok');
  });

  it('segnala fuori banda sotto il 20% e sopra l’80%', () => {
    expect(batteryBand(19)).toBe('low');
    expect(batteryBand(0)).toBe('low');
    expect(batteryBand(81)).toBe('high');
    expect(batteryBand(100)).toBe('high');
  });

  it('accetta soglie personalizzate', () => {
    expect(batteryBand(30, { protectMinPercent: 40, protectMaxPercent: 60 })).toBe('low');
    expect(batteryBand(50, { protectMinPercent: 40, protectMaxPercent: 60 })).toBe('ok');
  });
});
