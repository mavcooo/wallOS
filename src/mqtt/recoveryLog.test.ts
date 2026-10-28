import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logRecovery } from '@/mqtt/recoveryLog';
import { useHomeStore } from '@/store/homeStore';

beforeEach(() => {
  useHomeStore.setState({ rawLog: [] });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('logRecovery', () => {
  it('scrive nel buffer RAW anche senza `crypto.randomUUID` (HTTP in LAN)', () => {
    // `randomUUID` vive solo nei secure context: dall'IP della LAN in HTTP non
    // esiste. Il log di boot del Safe Boot non deve far cadere il render.
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(3),
    });

    expect(() => logRecovery('comandi in coda scartati')).not.toThrow();

    const [entry] = useHomeStore.getState().rawLog;
    expect(entry?.topic).toBe('recovery');
    expect(entry?.payload).toBe('comandi in coda scartati');
    expect(entry?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('preferisce `crypto.randomUUID` quando il contesto è sicuro', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      getRandomValues: (bytes: Uint8Array) => bytes.fill(3),
    });

    logRecovery('riavvio pulito');

    expect(useHomeStore.getState().rawLog[0]?.id).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
  });
});
