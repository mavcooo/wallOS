import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TopologyGate } from '@/components/auth/TopologyGate';
import { readTopologyCache, saveTopologyCache } from '@/lib/topologyCache';
import type { Topology } from '@/lib/topologyApi';
import { useHomeStore } from '@/store/homeStore';
import { SEED_TOPOLOGY } from '@/test/fixtures';

vi.mock('@/lib/topologyApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/topologyApi')>();
  return { ...actual, fetchTopology: vi.fn() };
});

const { fetchTopology } = await import('@/lib/topologyApi');

function renderGate() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <TopologyGate>
        <div>casa pronta</div>
      </TopologyGate>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(fetchTopology).mockReset();
  useHomeStore.setState({ deviceStates: {} });
});

describe('TopologyGate · bootstrap asincrono', () => {
  it('mostra lo splash brandizzato finché la topologia non arriva, poi allinea le righe realtime', async () => {
    let resolveFetch!: (topology: Topology) => void;
    vi.mocked(fetchTopology).mockImplementation(
      () =>
        new Promise<Topology>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    renderGate();

    expect(screen.getByText('DOMUS')).toBeInTheDocument();
    expect(screen.getByText('Carico la casa…')).toBeInTheDocument();
    expect(screen.queryByText('casa pronta')).not.toBeInTheDocument();

    await act(async () => {
      resolveFetch(SEED_TOPOLOGY);
    });

    expect(await screen.findByText('casa pronta')).toBeInTheDocument();
    // La topologia resta in TanStack Query; lo store riceve solo il runtime.
    expect(Object.keys(useHomeStore.getState().deviceStates)).toHaveLength(
      SEED_TOPOLOGY.devices.length,
    );
    // La risposta valida alimenta la cache per il prossimo avvio offline.
    expect(readTopologyCache()?.topology.rooms).toHaveLength(SEED_TOPOLOGY.rooms.length);
  });

  it('in errore offre Riprova e riprova davvero', async () => {
    vi.mocked(fetchTopology)
      .mockRejectedValueOnce(new Error('Gateway non raggiungibile'))
      .mockResolvedValueOnce(SEED_TOPOLOGY);

    renderGate();

    expect(await screen.findByText('Gateway non raggiungibile')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Avvia con i dati salvati' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));

    expect(await screen.findByText('casa pronta')).toBeInTheDocument();
    expect(vi.mocked(fetchTopology)).toHaveBeenCalledTimes(2);
  });

  it('con il backend irraggiungibile può partire dalla topologia salvata', async () => {
    saveTopologyCache(SEED_TOPOLOGY, Date.now() - 60_000);
    vi.mocked(fetchTopology).mockRejectedValue(new Error('offline'));

    renderGate();

    const useCache = await screen.findByRole('button', { name: 'Avvia con i dati salvati' });
    await userEvent.click(useCache);

    expect(await screen.findByText('casa pronta')).toBeInTheDocument();
    expect(useHomeStore.getState().deviceStates['light-living-main']).toBeDefined();
  });
});
