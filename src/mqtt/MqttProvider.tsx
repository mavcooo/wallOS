import { createContext, useContext, type ReactNode } from 'react';

import { useMqtt, type MqttApi } from '@/hooks/useMqtt';
import { useHomeStore } from '@/store/homeStore';

const MqttContext = createContext<MqttApi | null>(null);

export function MqttProvider({ children }: { children: ReactNode }) {
  // Gli scenari possono arrivare dopo il connect: lo store li idrata dal DB.
  const scenarios = useHomeStore((state) => state.scenarios);
  const api = useMqtt(scenarios);
  return <MqttContext.Provider value={api}>{children}</MqttContext.Provider>;
}

export function useMqttApi(): MqttApi {
  const context = useContext(MqttContext);
  if (!context) throw new Error('useMqttApi deve essere usato dentro <MqttProvider>');
  return context;
}
