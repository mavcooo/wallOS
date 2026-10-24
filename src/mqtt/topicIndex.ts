import { stateTopics, withBaseTopic } from '@/mqtt/topics';
import type { DeviceMetadata } from '@/types/device';
import type { BrokerSettings } from '@/types/mqtt';

/**
 * Indice topic → device, costruito solo quando cambia la topologia.
 *
 * Il percorso critico (un messaggio ogni pochi ms) resta O(1): niente scansione
 * lineare dell'elenco device. I device statici vivono sotto `baseTopic`, quelli
 * scoperti usano topic assoluti.
 */
export function buildTopicIndex(
  devices: readonly DeviceMetadata[],
  settings: BrokerSettings,
): Map<string, DeviceMetadata> {
  const index = new Map<string, DeviceMetadata>();
  for (const device of devices) {
    for (const topic of stateTopics(device)) {
      const wire = device.discovery ? topic : withBaseTopic(settings, topic);
      index.set(wire, device);
    }
  }
  return index;
}
