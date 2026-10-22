import type { Device } from '@/types/device';
import type { BrokerSettings } from '@/types/mqtt';

/** Applica il prefisso ambiente/tenant ai topic dichiarati nel config. */
export function withBaseTopic(settings: BrokerSettings, topic: string): string {
  const base = settings.baseTopic.trim().replace(/^\/+|\/+$/g, '');
  return base ? `${base}/${topic}` : topic;
}

export function stripBaseTopic(settings: BrokerSettings, topic: string): string {
  const base = settings.baseTopic.trim().replace(/^\/+|\/+$/g, '');
  if (!base) return topic;
  return topic.startsWith(`${base}/`) ? topic.slice(base.length + 1) : topic;
}

export function buildBrokerUrl(settings: BrokerSettings): string {
  const host = settings.host.trim() || 'localhost';
  const path = settings.path.trim() || '/mqtt';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${settings.protocol}://${host}:${settings.port}${normalizedPath}`;
}

export function stateTopics(device: Device): string[] {
  return device.topics.availability
    ? [device.topics.state, device.topics.availability]
    : [device.topics.state];
}
