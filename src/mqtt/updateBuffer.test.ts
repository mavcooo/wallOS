import { describe, expect, it, vi } from 'vitest';

import { TelemetryUpdateBuffer } from '@/mqtt/updateBuffer';
import { deviceOf } from '@/test/fixtures';

const power = deviceOf('power-kitchen-dishwasher', 'power');

/**
 * Il buffer non compone più il view-model: riceve lo snapshot già usato per il
 * decode. Questi test fissano il contratto (un solo snapshot per patch) e la
 * fusione telemetria + critico.
 */
describe('TelemetryUpdateBuffer · snapshot del device', () => {
  it('accoda la telemetria e la applica al flush con il timestamp di arrivo', () => {
    const applyCritical = vi.fn();
    const applyTelemetry = vi.fn();
    const buffer = new TelemetryUpdateBuffer(
      { applyCritical, applyTelemetry },
      { throttleMs: 1_000, significantDeltaRatio: 0.02 },
    );

    // +0,4 W: sotto la soglia di significatività, resta in finestra.
    expect(
      buffer.push(power, { kind: 'power', state: { watts: 1_180.4 } }, 1_000),
    ).toBe('telemetry');
    expect(applyCritical).not.toHaveBeenCalled();
    expect(applyTelemetry).not.toHaveBeenCalled();

    buffer.flush();

    expect(applyTelemetry).toHaveBeenCalledExactlyOnceWith([
      {
        deviceId: power.id,
        decoded: { kind: 'power', state: { watts: 1_180.4 } },
        at: 1_000,
      },
    ]);
    buffer.dispose();
  });

  it('fonde la telemetria in attesa nel successivo campo critico', () => {
    const applyCritical = vi.fn();
    const applyTelemetry = vi.fn();
    const buffer = new TelemetryUpdateBuffer({ applyCritical, applyTelemetry });

    buffer.push(power, { kind: 'power', state: { watts: 1_180.4 } }, 2_000);
    expect(buffer.push(power, { kind: 'power', state: { on: false } }, 2_001)).toBe(
      'critical',
    );

    expect(applyCritical).toHaveBeenCalledExactlyOnceWith(power.id, {
      kind: 'power',
      state: { watts: 1_180.4, on: false },
    });
    // Il campione in attesa non viene applicato due volte.
    expect(applyTelemetry).not.toHaveBeenCalled();
    buffer.dispose();
  });

  it('ignora una patch di un tipo diverso dallo snapshot', () => {
    const applyCritical = vi.fn();
    const applyTelemetry = vi.fn();
    const buffer = new TelemetryUpdateBuffer({ applyCritical, applyTelemetry });

    expect(
      buffer.push(power, { kind: 'light', state: { on: true } }, 3_000),
    ).toBe('ignored');

    buffer.dispose();
    expect(applyCritical).not.toHaveBeenCalled();
    expect(applyTelemetry).not.toHaveBeenCalled();
  });
});
