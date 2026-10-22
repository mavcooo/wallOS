import type { AdapterId } from '@/types/device';
import { customJsonAdapter } from './customJson';
import { haDiscoveryAdapter } from './haDiscovery';
import { shellyAdapter } from './shelly';
import { tasmotaAdapter } from './tasmota';
import type { DeviceAdapter } from './types';
import { zigbee2mqttAdapter } from './zigbee2mqtt';

export const ADAPTERS: Record<AdapterId, DeviceAdapter> = {
  zigbee2mqtt: zigbee2mqttAdapter,
  shelly: shellyAdapter,
  tasmota: tasmotaAdapter,
  'custom-json': customJsonAdapter,
  'ha-discovery': haDiscoveryAdapter,
};

export function getAdapter(id: AdapterId): DeviceAdapter {
  return ADAPTERS[id];
}

export type { DecodeContext, DeviceAdapter } from './types';
