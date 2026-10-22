const PIN_SALT = 'domus-kiosk::pin::v1';

/** PIN di fabbrica del pannello demo: va cambiato al primo avvio reale. */
export const DEFAULT_PIN = '1234';

export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`${PIN_SALT}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Confronto a tempo costante (evita timing attack sul PIN locale). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyPinHash(pin: string, hash: string): Promise<boolean> {
  const candidate = await hashPin(pin);
  return safeEqual(candidate, hash);
}

export function isPinLengthValid(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}
