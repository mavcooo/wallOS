import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn, formatKwh, formatTemp, formatWatts } from '@/lib/utils';

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

const PADDING = { top: 14, right: 12, bottom: 18, left: 44 } as const;

export type TelemetryMetric = 'power_watts' | 'energy_kwh' | 'temperature' | 'humidity';
export type TelemetryRange = '24h' | '7d' | '30d';

/** Punto della serie storica restituito da `GET /api/telemetry/history`. */
export interface TelemetryPoint {
  /** Epoch in millisecondi. */
  timestamp: number;
  value: number;
  min?: number;
  max?: number;
}

export interface TelemetryChartProps {
  /** Dispositivo da interrogare: senza id la card resta vuota. */
  deviceId: string;
  metric: TelemetryMetric;
  /** Intervallo iniziale; i bottoni touch lo cambiano localmente. */
  range?: TelemetryRange;
}

const RANGES: TelemetryRange[] = ['24h', '7d', '30d'];

async function fetchHistory(
  deviceId: string,
  metric: TelemetryMetric,
  range: TelemetryRange,
): Promise<TelemetryPoint[]> {
  const params = new URLSearchParams({ deviceId, metric, range });
  const response = await fetch(`${API_BASE}/telemetry/history?${params}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Telemetria non disponibile (${response.status})`);
  }
  const payload = (await response.json()) as { points?: TelemetryPoint[] };
  return Array.isArray(payload.points) ? payload.points : [];
}

function formatValue(metric: TelemetryMetric, value: number): string {
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
 * TelemetryChart - serie storica canvas-based per display touch.
 *
 * Il canvas evita centinaia di nodi DOM sui Raspberry Pi del pannello; i
 * bottoni del range sono sopra i 44px per restare usabili col dito.
 */
export function TelemetryChart({ deviceId, metric, range = '24h' }: TelemetryChartProps) {
  const { t } = useTranslation('energy');
  const [selectedRange, setSelectedRange] = useState<TelemetryRange>(range);
  const [hovered, setHovered] = useState<TelemetryPoint | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setSelectedRange(range);
  }, [range]);

  const query = useQuery({
    queryKey: ['telemetry', deviceId, metric, selectedRange],
    queryFn: () => fetchHistory(deviceId, metric, selectedRange),
    enabled: Boolean(deviceId),
    staleTime: 60_000,
  });

  const points = query.data ?? [];
  const lastPoint = points.length > 0 ? points[points.length - 1] : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container || points.length === 0) return;

    const draw = () => {
      const width = container.clientWidth || 320;
      const height = container.clientHeight || 150;
      const ratio = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      let minValue = points[0]?.value ?? 0;
      let maxValue = minValue;
      for (const point of points) {
        if (point.value < minValue) minValue = point.value;
        if (point.value > maxValue) maxValue = point.value;
      }

      const chartWidth = Math.max(1, width - PADDING.left - PADDING.right);
      const chartHeight = Math.max(1, height - PADDING.top - PADDING.bottom);
      const span = maxValue - minValue || 1;

      const xScale = (index: number) =>
        points.length === 1
          ? PADDING.left + chartWidth / 2
          : PADDING.left + (index / (points.length - 1)) * chartWidth;
      const yScale = (value: number) =>
        PADDING.top + chartHeight - ((value - minValue) / span) * chartHeight;

      // Assi e tacche min/max.
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PADDING.left, PADDING.top);
      ctx.lineTo(PADDING.left, PADDING.top + chartHeight);
      ctx.lineTo(PADDING.left + chartWidth, PADDING.top + chartHeight);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatValue(metric, maxValue), PADDING.left - 6, PADDING.top);
      ctx.fillText(formatValue(metric, minValue), PADDING.left - 6, PADDING.top + chartHeight);

      // Linea della serie.
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach((point, index) => {
        const x = xScale(index);
        const y = yScale(point.value);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Ultimo campione evidenziato.
      if (lastPoint) {
        const index = points.length - 1;
        ctx.fillStyle = '#ff6b6b';
        ctx.beginPath();
        ctx.arc(xScale(index), yScale(lastPoint.value), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [points, metric, lastPoint]);

  const handleTouch = (clientX: number, rect: DOMRect) => {
    if (points.length === 0) return;
    const chartWidth = Math.max(1, rect.width - PADDING.left - PADDING.right);
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left - PADDING.left) / chartWidth));
    const index = Math.round(fraction * (points.length - 1));
    setHovered(points[index] ?? null);
  };

  const loading = query.isPending && Boolean(deviceId);
  const failed = query.isError;
  const empty = !loading && !failed && points.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-xs font-medium text-fg">{t(`metric.${metric}`)}</h3>
        <div className="flex gap-1" role="group" aria-label={t('telemetry.rangeAria')}>
          {RANGES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSelectedRange(value)}
              aria-pressed={selectedRange === value}
              className={cn(
                'min-h-11 min-w-14 rounded-full border px-3 text-[11px] font-medium transition-colors',
                selectedRange === value
                  ? 'border-accent/30 bg-accent-soft text-accent'
                  : 'border-line bg-panel-2 text-fg-subtle',
              )}
            >
              {t(`telemetry.range.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div
        className="relative h-[150px] overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel-2/40"
        onTouchStart={(event) => {
          const touch = event.touches[0];
          const rect = event.currentTarget.getBoundingClientRect();
          if (touch) handleTouch(touch.clientX, rect);
        }}
        onTouchMove={(event) => {
          const touch = event.touches[0];
          const rect = event.currentTarget.getBoundingClientRect();
          if (touch) handleTouch(touch.clientX, rect);
        }}
        onTouchEnd={() => setHovered(null)}
        onMouseLeave={() => setHovered(null)}
      >
        {loading ? (
          <p className="p-4 text-center text-xs text-fg-subtle">{t('telemetry.loading')}</p>
        ) : failed ? (
          <p className="p-4 text-center text-xs text-fg-subtle">{t('telemetry.error')}</p>
        ) : empty ? (
          <p className="p-4 text-center text-xs text-fg-subtle">
            {deviceId ? t('telemetry.empty') : t('telemetry.noDevice')}
          </p>
        ) : (
          <canvas ref={canvasRef} className="block size-full" aria-hidden="true" />
        )}

        {hovered ? (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-panel px-3 py-1 text-[10px] text-fg shadow-sm">
            {formatValue(metric, hovered.value)}
          </div>
        ) : null}
      </div>

      {points.length > 0 ? (
        <div className="flex justify-between text-[10px] text-fg-subtle">
          <span>{t('telemetry.points', { count: points.length })}</span>
          {lastPoint ? <span>{formatValue(metric, lastPoint.value)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
