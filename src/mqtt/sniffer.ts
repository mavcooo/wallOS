import type { AdapterId } from '@/types/device';

/** Wildcard generiche: coprono le famiglie firmware supportate dagli adapter. */
export const SNIFFER_FILTERS = [
  'tele/#',
  'stat/#',
  'zigbee2mqtt/#',
  'shellies/#',
] as const;

export interface SnifferSuggestion {
  adapter: AdapterId;
  name: string;
  stateTopic: string;
  commandTopic?: string;
  availabilityTopic?: string;
}

/** `+` deve occupare un intero livello; `#` può essere solo l'ultimo livello. */
export function isValidTopicFilter(filter: string): boolean {
  const value = filter.trim();
  if (value.length === 0 || value.length > 256 || /\s/.test(value)) return false;
  const levels = value.split('/');
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index] ?? '';
    if (level.includes('#') && (level !== '#' || index !== levels.length - 1)) return false;
    if (level.includes('+') && level !== '+') return false;
  }
  return true;
}

/** Topic di pubblicazione/sottoscrizione puntuale: nessuna wildcard. */
export function isValidDeviceTopic(topic: string): boolean {
  const value = topic.trim();
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\s+#]/.test(value)
  );
}

function humanName(segment: string | undefined): string {
  if (!segment) return '';
  return segment
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

/**
 * Deducibile dal solo topic ascoltato: adapter, nome proposto e topic di
 * comando/availability coerenti con la famiglia firmware.
 */
export function suggestFromTopic(rawTopic: string): SnifferSuggestion {
  const topic = rawTopic.trim().replace(/\/+$/, '');
  const parts = topic.split('/');
  const prefix = parts[0] ?? '';

  if (prefix === 'zigbee2mqtt') {
    const friendly = parts[1] ?? 'device';
    const base = `zigbee2mqtt/${friendly}`;
    return {
      adapter: 'zigbee2mqtt',
      name: humanName(friendly),
      stateTopic: topic.endsWith('/set') ? base : topic,
      commandTopic: `${base}/set`,
      availabilityTopic: `${base}/availability`,
    };
  }

  if (prefix === 'shellies') {
    const device = parts[1] ?? 'shelly';
    const isRelay = /^relay\/\d+(\/command)?$/.test(parts.slice(2).join('/'));
    const base = isRelay ? `shellies/${device}/relay/${parts[3] ?? '0'}` : topic;
    return {
      adapter: 'shelly',
      name: humanName(device),
      stateTopic: base,
      commandTopic: isRelay ? `${base}/command` : undefined,
      availabilityTopic: `shellies/${device}/online`,
    };
  }

  if (prefix === 'tele' || prefix === 'stat') {
    const device = parts[1] ?? 'tasmota';
    return {
      adapter: 'tasmota',
      name: humanName(device),
      stateTopic: topic.endsWith('/STATE') ? topic : `tele/${device}/STATE`,
      commandTopic: `cmnd/${device}/POWER`,
      availabilityTopic: `tele/${device}/LWT`,
    };
  }

  return {
    adapter: 'custom-json',
    name: humanName(parts[1] ?? parts[0]),
    stateTopic: topic,
    commandTopic: topic.endsWith('/state')
      ? `${topic.slice(0, -'/state'.length)}/set`
      : undefined,
  };
}
