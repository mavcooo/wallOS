import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import { fetchTopology, type Topology } from '@/lib/topologyApi';
import {
  readTopologyCache,
  saveTopologyCache,
  type TopologyCacheEntry,
} from '@/lib/topologyCache';

export interface TopologyQueryResult {
  cached: TopologyCacheEntry | null;
}

/**
 * Topologia dal gateway, con cache persistente per l'avvio offline.
 *
 * Il hook non tocca lo store: `TopologyGate` idrata Zustand quando i dati
 * arrivano, così il resto dell'app non conosce TanStack Query.
 */
export function useTopologyQuery(): UseQueryResult<Topology> & TopologyQueryResult {
  const query = useQuery({
    queryKey: TOPOLOGY_QUERY_KEY,
    queryFn: fetchTopology,
  });

  // La cache viene letta una volta al mount (per l'errore immediato) e poi
  // riscritta a ogni risposta valida.
  const [cached, setCached] = useState<TopologyCacheEntry | null>(() => readTopologyCache());

  useEffect(() => {
    if (!query.data) return;
    setCached(saveTopologyCache(query.data));
  }, [query.data]);

  return { ...query, cached };
}
