import { createContext, useContext, type ReactNode } from 'react';

import { useAvailabilityWatchdog } from '@/hooks/useAvailabilityWatchdog';
import { useMqtt, type MqttApi } from '@/hooks/useMqtt';
import { useDevices, useScenarios } from '@/hooks/useTopologyQuery';

const MqttContext = createContext<MqttApi | null>(null);

export function MqttProvider({ children }: { children: ReactNode }) {
  // Topologia e scenari sono server-state: nessuna copia in homeStore.
  const devices = useDevices();
  const scenarios = useScenarios();
  const api = useMqtt(scenarios, devices);
  // I sensori a batteria non hanno LWT: il silenzio è l'unico segnale di guasto.
  useAvailabilityWatchdog(devices);
  return <MqttContext.Provider value={api}>{children}</MqttContext.Provider>;
}

export function useMqttApi(): MqttApi {
  const context = useContext(MqttContext);
  if (!context) throw new Error('useMqttApi deve essere usato dentro <MqttProvider>');
  return context;
}
