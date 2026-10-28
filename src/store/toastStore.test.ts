import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectCriticalCount, useToastStore } from '@/store/toastStore';

beforeEach(() => {
  useToastStore.setState({ toasts: [], history: [], alarmSilenced: false });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('toastStore · ambienti senza Web Crypto completo', () => {
  it('crea notifiche anche senza `crypto.randomUUID` (HTTP in LAN)', () => {
    // Su `http://192.168.0.101:3000` il secure context manca: `randomUUID` è
    // undefined e la chiamata diretta faceva fallire il primo toast del boot.
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });

    expect(() => {
      useToastStore.getState().push({ title: 'Lavatrice', tone: 'success' });
    }).not.toThrow();

    expect(useToastStore.getState().toasts[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('toastStore · priorità', () => {
  it('auto-dismiss info dopo 4s e warning dopo 9s', () => {
    const { push } = useToastStore.getState();
    push({ title: 'Luce accesa', tone: 'success' });
    push({ title: 'Broker instabile', tone: 'error' });

    expect(useToastStore.getState().toasts).toHaveLength(2);

    vi.advanceTimersByTime(4_000);
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Broker instabile',
    ]);

    vi.advanceTimersByTime(5_000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('un allarme critical non sparisce da solo e non si chiude con dismiss', () => {
    const id = useToastStore.getState().addCritical({
      title: 'Fumo rilevato',
      description: 'Cucina',
      requirePin: true,
      metadata: { type: 'smoke', room: 'cucina' },
    });

    vi.advanceTimersByTime(10 * 60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(selectCriticalCount(useToastStore.getState())).toBe(1);

    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('acknowledgeCritical sposta l’allarme nello storico e ripristina la sirena', () => {
    const { addCritical, silenceAlarm, acknowledgeCritical } = useToastStore.getState();
    const id = addCritical({ title: 'Allagamento', metadata: { type: 'flood' } });

    silenceAlarm();
    expect(useToastStore.getState().alarmSilenced).toBe(true);

    acknowledgeCritical(id);

    const state = useToastStore.getState();
    expect(state.toasts).toHaveLength(0);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.acknowledgedAt).toBeTypeOf('number');
    expect(state.alarmSilenced).toBe(false);
  });

  it('un nuovo allarme riattiva la sirena anche se era stata tacitata', () => {
    const { addCritical, silenceAlarm } = useToastStore.getState();
    addCritical({ title: 'Fumo', metadata: { type: 'smoke' } });
    silenceAlarm();

    addCritical({ title: 'Allagamento', metadata: { type: 'flood' } });

    expect(selectCriticalCount(useToastStore.getState())).toBe(2);
    expect(useToastStore.getState().alarmSilenced).toBe(false);
  });

  it('la coda limita i toast transitori ma tiene tutti i critici', () => {
    const { push, addCritical } = useToastStore.getState();
    for (let index = 0; index < 8; index += 1) {
      push({ title: `Info ${index}` });
    }
    addCritical({ title: 'Fumo', metadata: { type: 'smoke' } });
    addCritical({ title: 'Allagamento', metadata: { type: 'flood' } });

    const state = useToastStore.getState();
    expect(state.toasts.filter((toast) => toast.priority !== 'critical')).toHaveLength(4);
    expect(selectCriticalCount(state)).toBe(2);
  });
});
