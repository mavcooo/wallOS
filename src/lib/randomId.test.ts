import { afterEach, describe, expect, it, vi } from 'vitest';

import { randomId } from '@/lib/randomId';

/** UUID v4 secondo RFC 4122: versione 4 e variante 8/9/a/b. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('randomId', () => {
  it('usa crypto.randomUUID quando il contesto è sicuro', () => {
    const uuid = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID: uuid });

    expect(randomId()).toBe('11111111-2222-4333-8444-555555555555');
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it('su HTTP in LAN (randomUUID assente) ripiega su getRandomValues', () => {
    // È lo scenario reale di `http://192.168.0.101:3000`: `crypto` esiste, ma
    // `randomUUID` no perché richiede un secure context.
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xab);
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    expect(() => randomId()).not.toThrow();
    expect(randomId()).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalled();
  });

  it('senza Web Crypto produce comunque un UUID v4 valido', () => {
    vi.stubGlobal('crypto', undefined);

    expect(randomId()).toMatch(UUID_V4);
    expect(randomId()).toHaveLength(36);
  });

  it('genera id distinti', () => {
    const ids = new Set(Array.from({ length: 64 }, () => randomId()));

    expect(ids.size).toBe(64);
  });
});
