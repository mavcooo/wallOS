import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectCriticalCount, useToastStore } from '@/store/toastStore';

beforeEach(() => {
  useToastStore.setState({ toasts: [], history: [], alarmSilenced: false });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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
