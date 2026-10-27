import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestQueryClient } from '@/test/query';

vi.mock('@/components/settings/TopologyManager', () => ({
  TopologyManager: () => null,
}));

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({
    sendAction: vi.fn(),
    publishRaw: vi.fn(),
    runScenario: vi.fn(),
    reconnect: vi.fn(),
    refreshSubscriptions: vi.fn(),
    subscribeSniffer: vi.fn(() => vi.fn()),
  }),
}));

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

const { SettingsPage } = await import('@/pages/SettingsPage');
const { useHomeStore } = await import('@/store/homeStore');

beforeEach(() => {
  localStorage.clear();
  // La pagina ora contiene la card del display, che idrata da `/api/kiosk/:id`:
  // un server finto evita richieste reali e risposte non JSON.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ display: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  delete document.documentElement.dataset.performanceMode;
  useHomeStore.getState().setPerformanceMode(false);
  useHomeStore.getState().setBurnInSettings({
    mode: 'screensaver-float',
    shiftIntervalMs: 60_000,
    dimClockOpacity: 0.3,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('SettingsPage · protezione burn-in', () => {
  it('cambia modalità, intervallo e opacità dell’orologio', async () => {
    renderPage();

    const float = screen.getByRole('button', { name: /Orologio flottante/ });
    expect(float).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: /Micro-shift/ }));
    expect(useHomeStore.getState().burnIn.mode).toBe('subtle-shift');
    expect(screen.getByRole('button', { name: /Micro-shift/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: '120 s' }));
    expect(useHomeStore.getState().burnIn.shiftIntervalMs).toBe(120_000);

    // Lo slider dell'opacità riflette il valore dello store.
    const opacity = screen.getByRole('slider');
    expect(opacity).toHaveAttribute('aria-valuenow', '30');
    expect(screen.getByText('30%')).toBeInTheDocument();
  });

  it('attiva la Performance Mode e la applica subito al documento', async () => {
    renderPage();

    const toggle = screen.getByRole('switch', {
      name: /Performance Mode \(Schermi Lenti \/ Raspberry Pi\)/,
    });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(useHomeStore.getState().ui.performanceMode).toBe(true);
    expect(document.documentElement.dataset.performanceMode).toBe('true');
    expect(toggle).toHaveAccessibleName(/Performance Mode \(Schermi Lenti \/ Raspberry Pi\)/);
  });

  it('mostra il riepilogo allineato alle impostazioni correnti', () => {
    useHomeStore.getState().setBurnInSettings({ mode: 'subtle-shift', shiftIntervalMs: 30_000 });

    renderPage();

    expect(screen.getByText(/micro-shift della dashboard/)).toBeInTheDocument();
    expect(screen.getByText(/ogni 30 s/)).toBeInTheDocument();
  });
});

describe('SettingsPage · sincronizzazione topologia', () => {
  it('cambia il raggruppamento degli eventi e lo riflette nello store', async () => {
    useHomeStore.getState().setTopologySyncSettings({ debounceMs: 300 });
    renderPage();

    expect(screen.getByRole('button', { name: '300 ms' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: '1 s' }));
    expect(useHomeStore.getState().topologySync.debounceMs).toBe(1_000);
    expect(screen.getByRole('button', { name: '1 s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 0 = refetch immediato: resta nel range supportato dal normalizzatore.
    await userEvent.click(screen.getByRole('button', { name: 'Subito' }));
    expect(useHomeStore.getState().topologySync.debounceMs).toBe(0);
  });
});
