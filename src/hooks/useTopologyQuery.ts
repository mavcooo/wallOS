import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { mergeTopologyWithDiscovery } from '@/lib/discovery';
import { TOPOLOGY_QUERY_KEY, TOPOLOGY_STALE_TIME } from '@/lib/queryClient';
import type { RoomConfig } from '@/lib/rooms';
import { fetchTopology, type Topology } from '@/lib/topologyApi';
import {
  readTopologyCache,
  saveTopologyCache,
  type TopologyCacheEntry,
} from '@/lib/topologyCache';
import type { Device, DeviceMetadata, Scenario } from '@/types/device';

const EMPTY_DEVICES: readonly Device[] = [];
const EMPTY_ROOMS: readonly RoomConfig[] = [];
const EMPTY_SCENARIOS: readonly Scenario[] = [];
const EMPTY_DEVICE_INDEX: Readonly<Record<string, Device>> = Object.freeze({});

/**
 * Indice condiviso tra tutte le card: la cache è legata all'array di device
 * (una nuova risposta topologia = un nuovo indice), non a ogni componente.
 */
const deviceIndexCache = new WeakMap<
  readonly Device[],
  Readonly<Record<string, Device>>
>();

function indexOf(devices: readonly Device[]): Readonly<Record<string, Device>> {
  if (devices.length === 0) return EMPTY_DEVICE_INDEX;
  const cached = deviceIndexCache.get(devices);
  if (cached) return cached;
  const index = Object.fromEntries(devices.map((device) => [device.id, device]));
  deviceIndexCache.set(devices, index);
  return index;
}

/** HTTP + entità HA scoperte sul dispositivo: unica topologia per la UI. */
function loadTopology(): Promise<Topology> {
  return fetchTopology().then(mergeTopologyWithDiscovery);
}

// Selettori a livello di modulo: identità stabile, quindi TanStack Query non
// ricalcola il risultato a ogni render e i componenti mantengono i riferimenti.
const selectDevices = (topology: Topology | undefined): readonly Device[] =>
  topology?.devices ?? EMPTY_DEVICES;
const selectRooms = (topology: Topology | undefined): readonly RoomConfig[] =>
  topology?.rooms ?? EMPTY_ROOMS;
const selectScenarios = (topology: Topology | undefined): readonly Scenario[] =>
  topology?.scenarios ?? EMPTY_SCENARIOS;

export interface TopologyQueryResult {
  cached: TopologyCacheEntry | null;
}

/**
 * Topologia dal gateway, con cache persistente per l'avvio offline.
 *
 * Usato dal `TopologyGate`, che sincronizza `homeStore.deviceStates` quando i
 * dati arrivano. Tutti gli altri componenti leggono i metadati da qui: il
 * resto dell'app non deve conoscerne lo stato di caricamento.
 */
export function useTopologyQuery(): UseQueryResult<Topology> & TopologyQueryResult {
  const query = useQuery({
    queryKey: TOPOLOGY_QUERY_KEY,
    queryFn: loadTopology,
    staleTime: TOPOLOGY_STALE_TIME,
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

/** Anagrafica device ordinata dal server (array stabile finché non cambia la cache). */
export function useDevices(): readonly Device[] {
  const { data } = useQuery({
    queryKey: TOPOLOGY_QUERY_KEY,
    queryFn: loadTopology,
    staleTime: TOPOLOGY_STALE_TIME,
    select: selectDevices,
  });
  return data ?? EMPTY_DEVICES;
}

/**
 * Indice O(1) `id -> metadati`. Costruito una sola volta per risposta della
 * topologia: le card non fanno `find` lineari sul payload.
 */
export function useDeviceIndex(): Readonly<Record<string, Device>> {
  const devices = useDevices();
  return useMemo(() => indexOf(devices), [devices]);
}

/** Metadati di un singolo device: nessun aggiornamento al ritmo della telemetria. */
export function useDeviceMetadata(deviceId: string): DeviceMetadata | undefined {
  return useDeviceIndex()[deviceId];
}

export function useRooms(): readonly RoomConfig[] {
  const { data } = useQuery({
    queryKey: TOPOLOGY_QUERY_KEY,
    queryFn: loadTopology,
    staleTime: TOPOLOGY_STALE_TIME,
    select: selectRooms,
  });
  return data ?? EMPTY_ROOMS;
}

export function useScenarios(): readonly Scenario[] {
  const { data } = useQuery({
    queryKey: TOPOLOGY_QUERY_KEY,
    queryFn: loadTopology,
    staleTime: TOPOLOGY_STALE_TIME,
    select: selectScenarios,
  });
  return data ?? EMPTY_SCENARIOS;
}
