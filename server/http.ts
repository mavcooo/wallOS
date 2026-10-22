export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readString(
  body: Record<string, unknown>,
  key: string,
  maxLength = 256,
): string | null {
  const value = body[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

export function readSecret(
  body: Record<string, unknown>,
  key: string,
  maxLength = 256,
): string | null {
  const value = body[key];
  if (typeof value !== 'string') return null;
  return value.length > 0 && value.length <= maxLength ? value : null;
}

export function readDigits(body: Record<string, unknown>, key: string): string | null {
  const value = readString(body, key, 16);
  return value && /^\d+$/.test(value) ? value : null;
}

export function readBoolean(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === 'boolean' ? value : null;
}
