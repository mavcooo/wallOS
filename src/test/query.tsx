import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import type { Topology } from '@/lib/topologyApi';
import { useHomeStore } from '@/store/homeStore';

/** Nessun refetch/retry: i test partono sempre dalla topologia seminata. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}

/**
 * Equivalente di un bootstrap completato: metadati nella cache Query e righe
 * realtime nello store, esattamente come dopo `TopologyGate`.
 */
export function seedTopology(client: QueryClient, topology: Topology): void {
  client.setQueryData(TOPOLOGY_QUERY_KEY, topology);
  useHomeStore.getState().syncDeviceStates(topology.devices);
}

export function QueryWrapper({
  client,
  children,
}: {
  client: QueryClient;
  children: ReactNode;
}) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

interface RenderWithTopology extends RenderOptions {
  topology?: Topology;
  client?: QueryClient;
}

export function renderWithTopology(
  ui: ReactElement,
  { topology, client = createTestQueryClient(), ...options }: RenderWithTopology = {},
): RenderResult & { client: QueryClient } {
  if (topology) seedTopology(client, topology);
  const result = render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
    options,
  );
  return { ...result, client };
}
