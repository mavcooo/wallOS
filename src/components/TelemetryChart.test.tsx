import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TelemetryChart,
  type TelemetryChartProps,
  type TelemetryPoint,
} from '@/components/TelemetryChart';

function stubHistory(points: TelemetryPoint[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ points }),
    })) as unknown as typeof fetch,
  );
}

function renderChart(props: Partial<TelemetryChartProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TelemetryChart deviceId="power-kitchen-oven" metric="power_watts" {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TelemetryChart', () => {
  it('mostra lo skeleton durante il caricamento del bucket', async () => {
    // Fetch che non risolve: la query resta in `isFetching`.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);

    renderChart();

    const skeleton = await screen.findByRole('status');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  it('spiega che lo storico è in accumulo quando non ci sono campioni', async () => {
    stubHistory([]);

    renderChart();

    expect(await screen.findByText('Dati storici in fase di accumulo…')).toBeInTheDocument();
    expect(
      screen.getByText('Il worker salva un campione al minuto: il primo punto comparirà a breve.'),
    ).toBeInTheDocument();
  });

  it('senza meter disponibili non interroga il server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderChart({ deviceId: null, enabled: false });

    expect(await screen.findByText('Nessun contatore disponibile')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('interroga l’aggregato di tutta la casa senza filtro device', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({
        points: [
          { timestamp: Date.now() - 60_000, value: 900 },
          { timestamp: Date.now(), value: 1200 },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderChart({ deviceId: null });

    expect(await screen.findByText('2 campioni')).toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('metric=power_watts');
    expect(url).not.toContain('deviceId');
  });

  it('interroga un device con id testuale e ne disegna i campioni', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({
        points: [
          { timestamp: Date.now() - 60_000, value: 40 },
          { timestamp: Date.now(), value: 80 },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    // `devices.id` è uno slug: il grafico non deve mai convertirla in UUID né
    // lasciare la card in stato di errore.
    renderChart({ deviceId: 'living-room-light' });

    expect(await screen.findByText('2 campioni')).toBeInTheDocument();
    expect(screen.queryByText('Dati storici in fase di accumulo…')).not.toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('deviceId=living-room-light');
    expect(url).toContain('range=24h');
  });

  it('usa la media aggregata e mostra gli estremi min–max nel tooltip', async () => {
    const now = Date.now();
    stubHistory([
      { timestamp: now - 60_000, value: 900, avg: 900, min: 500, max: 1500, samples: 4 },
      { timestamp: now, value: 1200, avg: 1200, min: 800, max: 2000, samples: 6 },
    ]);

    const { container } = renderChart();
    expect(await screen.findByText('2 campioni')).toBeInTheDocument();

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    // Il tooltip è sul contenitore del canvas: un touch seleziona il punto.
    fireEvent.touchStart(canvas?.parentElement as HTMLElement, {
      touches: [{ clientX: 120 }],
    });

    // Media come valore principale e picco/minimo del bucket nel tooltip.
    expect((await screen.findAllByText('1,2 kW')).length).toBeGreaterThan(0);
    expect(screen.getByText('800 W – 2 kW')).toBeInTheDocument();
  });

  it('renderizza i punti aggregati e notifica il cambio intervallo', async () => {
    stubHistory([
      { timestamp: Date.now() - 60_000, value: 900 },
      { timestamp: Date.now(), value: 1200 },
    ]);
    const onRangeChange = vi.fn();

    renderChart({ onRangeChange });

    expect(await screen.findByText('2 campioni')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '7 giorni' }));

    expect(onRangeChange).toHaveBeenCalledExactlyOnceWith('7d');
    expect(screen.getByRole('button', { name: '7 giorni' })).toHaveAttribute('aria-pressed', 'true');
    // Il fetch successivo usa il nuovo range: il grafico resta pilotato dal genitore.
    await screen.findAllByText('1,2 kW');
  });
});
