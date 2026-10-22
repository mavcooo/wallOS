import { initialDevices } from '@/config/devices.config';
import type { Device } from '@/types/device';

/**
 * Device del seed demo, tipizzato sul `kind` richiesto:
 * `deviceOf('light-living-main', 'light')`.
 */
export function deviceOf<K extends Device['kind']>(
  id: string,
  kind: K,
): Extract<Device, { kind: K }> {
  const device = initialDevices.find((item) => item.id === id);
  if (!device) throw new Error(`device "${id}" non presente in devices.config`);
  if (device.kind !== kind) {
    throw new Error(`device "${id}" è di tipo ${device.kind}, atteso ${kind}`);
  }
  return device as Extract<Device, { kind: K }>;
}
