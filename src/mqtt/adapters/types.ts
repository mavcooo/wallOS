import type { ControlAction, DecodedState, Device, EncodedCommand } from '@/types/device';

export interface DecodeContext {
  device: Device;
  topic: string;
  payload: string;
}

export interface DeviceAdapter {
  /** Nome leggibile mostrato nel pannello impostazioni. */
  readonly label: string;
  /** Traduce un payload MQTT in una patch normalizzata (null = ignora). */
  decode(ctx: DecodeContext): DecodedState | null;
  /** Traduce un'azione astratta nel payload atteso dal firmware. */
  encode(device: Device, action: ControlAction): EncodedCommand | null;
}

export function parseJson(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Interpreta i tantissimi dialetti "on/off" dei firmware domestici. */
export function isOn(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['on', 'true', 'open', '1', 'online', 'heat', 'cool'].includes(normalized)) return true;
  if (['off', 'false', 'closed', '0', 'offline'].includes(normalized)) return false;
  return undefined;
}

export function commandTopic(device: Device, suffix = ''): string {
  return `${device.topics.command ?? ''}${suffix}`;
}

export function jsonCommand(
  device: Device,
  payload: Record<string, unknown>,
  suffix = '',
): EncodedCommand {
  return { topic: commandTopic(device, suffix), payload: JSON.stringify(payload), qos: 0 };
}
