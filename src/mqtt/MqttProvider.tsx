import { createContext, useContext, type ReactNode } from 'react';

import { SCENARIOS } from '@/config/scenarios.config';
import { useMqtt, type MqttApi } from '@/hooks/useMqtt';

const MqttContext = createContext<MqttApi | null>(null);

export function MqttProvider({ children }: { children: ReactNode }) {
  const api = useMqtt(SCENARIOS);
  return <MqttContext.Provider value={api}>{children}</MqttContext.Provider>;
}

export function useMqttApi(): MqttApi {
  const context = useContext(MqttContext);
  if (!context) throw new Error('useMqttApi deve essere usato dentro <MqttProvider>');
  return context;
}
