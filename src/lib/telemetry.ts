import { TELEMETRY_DEFAULTS, TELEMETRY_LIMITS } from '@/config/app.config';
import { formatKwh, formatTemp, formatWatts } from '@/lib/utils';
import type { TelemetrySettings } from '@/types/telemetry';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

/** Stesse metriche di `server/routes/telemetry.ts`. */
export type TelemetryMetric = 'power_watts' | 'energy_kwh' | 'temperature' | 'humidity';
export type TelemetryRange = '24h' | '7d' | '30d';

/** Punto aggregato restituito da `GET /api/telemetry/history`. */
export interface TelemetryPoint {
  /** Epoch in millisecondi (bucket già allineato dal server). */
  timestamp: number;
  value: number;
  min?: number | null;
  max?: number | null;
  /** Campioni grezzi confluiti nel bucket. */
  samples?: number;
}

/** Riepilogo della finestra restituito da `GET /api/telemetry/summary`. */
export interface TelemetrySummary {
  min: number | null;
  max: number | null;
  avg: number | null;
  total: number | null;
  count: number;
}

/** Formattazione coerente fra grafico, statistiche e tooltip. */
export function formatTelemetryValue(metric: TelemetryMetric, value: number): string {
  switch (metric) {
    case 'power_watts':
      return formatWatts(value);
    case 'energy_kwh':
      return formatKwh(value);
    case 'temperature':
      return formatTemp(value);
    case 'humidity':
      return `${Math.round(value)}%`;
  }
}

/**
 * Serie storica aggregata. Il server sceglie il bucket in base al range
 * (30 min / 1 h / 1 giorno) e restituisce i punti già ordinati.
 * `deviceId: null` = aggregato di tutta la casa (somma dei meter).
 */
export async function fetchTelemetryHistory(
  deviceId: string | null,
  metric: TelemetryMetric,
  range: TelemetryRange,
  signal?: AbortSignal,
): Promise<TelemetryPoint[]> {
  const params = new URLSearchParams({ metric, range });
  if (deviceId) params.set('deviceId', deviceId);
  const response = await fetch(`${API_BASE}/telemetry/history?${params}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Telemetria non disponibile (${response.status})`);
  }
  const payload = (await response.json()) as { points?: TelemetryPoint[] };
  return Array.isArray(payload.points) ? payload.points : [];
}

/** Picco, media e totale della stessa finestra usata dal grafico. */
export async function fetchTelemetrySummary(
  deviceId: string | null,
  metric: TelemetryMetric,
  range: TelemetryRange,
  signal?: AbortSignal,
): Promise<TelemetrySummary> {
  const params = new URLSearchParams({ metric, range });
  if (deviceId) params.set('deviceId', deviceId);
  const response = await fetch(`${API_BASE}/telemetry/summary?${params}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Riepilogo telemetria non disponibile (${response.status})`);
  }
  const payload = (await response.json()) as { summary?: Partial<TelemetrySummary> };
  const summary = payload.summary ?? {};
  return {
    min: typeof summary.min === 'number' ? summary.min : null,
    max: typeof summary.max === 'number' ? summary.max : null,
    avg: typeof summary.avg === 'number' ? summary.avg : null,
    total: typeof summary.total === 'number' ? summary.total : null,
    count: typeof summary.count === 'number' ? summary.count : 0,
  };
}

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
