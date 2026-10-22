import { TELEMETRY_DEFAULTS, TELEMETRY_LIMITS } from '@/config/app.config';
import type { TelemetrySettings } from '@/types/telemetry';

/** Converte la configurazione richiesta in un valore valido e supportato. */
export function normalizeTelemetrySettings(patch?: Partial<TelemetrySettings>): TelemetrySettings {
  const requestedThrottle =
    typeof patch?.throttleMs === 'number' && Number.isFinite(patch.throttleMs)
      ? patch.throttleMs
      : TELEMETRY_DEFAULTS.throttleMs;
  const requestedRatio =
    typeof patch?.significantDeltaRatio === 'number' && Number.isFinite(patch.significantDeltaRatio)
      ? patch.significantDeltaRatio
      : TELEMETRY_DEFAULTS.significantDeltaRatio;

  return {
    throttleMs: Math.min(
      TELEMETRY_LIMITS.maxThrottleMs,
      Math.max(TELEMETRY_LIMITS.minThrottleMs, Math.round(requestedThrottle)),
    ),
    significantDeltaRatio: Math.min(1, Math.max(0, requestedRatio)),
  };
}
