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

/**
 * Topic da sottoscrivere per un device: quelli dichiarati nel seed più, per le
 * entità scoperte, tutti i canali di stato e di availability dell'annuncio.
 */
export function stateTopics(device: Device): string[] {
  const topics = new Set<string>();
  if (device.topics.state) topics.add(device.topics.state);
  if (device.topics.availability) topics.add(device.topics.availability);
  for (const channel of device.discovery?.state ?? []) topics.add(channel.topic);
  for (const entry of device.discovery?.availability ?? []) topics.add(entry.topic);
  return [...topics];
}
