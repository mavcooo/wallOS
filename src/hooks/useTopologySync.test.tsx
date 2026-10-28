import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { TOPOLOGY_SYNC_DEFAULTS } from '@/config/app.config';
import { useTopologySync } from '@/hooks/useTopologySync';
import { FLOORPLAN_QUERY_KEY, TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import { emitTopologyChanged, parseTopologyChanged } from '@/mqtt/topologyEvents';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore, type ToastInput } from '@/store/toastStore';

// `useMqttApi` è l'unica dipendenza della socket: il test non apre connessioni.
const mocks = vi.hoisted(() => ({ refreshSubscriptions: vi.fn() }));

vi.mock('@/mqtt/MqttProvider', () => ({ useMqttApi: () => mocks }));

/** Finestra di default: il valore attivo vive in `homeStore.topologySync`. */
const DEBOUNCE = TOPOLOGY_SYNC_DEFAULTS.debounceMs;

/** EventSource finto: jsdom non lo implementa, qui si comanda apertura e messaggi. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  readonly init?: EventSourceInit;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.init = init;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function eventOf(overrides: Record<string, unknown> = {}) {
  const parsed = parseTopologyChanged(
    JSON.stringify({
      event: 'room_updated',
      entity: 'room',
      id: 'living',
      timestamp: Date.now(),
      ...overrides,
    }),
  );
  if (!parsed) throw new Error('payload di test non valido');
  return parsed;
}

let pushSpy: MockInstance<(input: ToastInput) => string>;

function renderSync() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useTopologySync(), { wrapper });
  return { ...view, invalidate };
}

beforeEach(() => {
  mocks.refreshSubscriptions.mockReset();
  useToastStore.setState({ toasts: [] });
  pushSpy = vi.spyOn(useToastStore.getState(), 'push');
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  const { getState } = useHomeStore;
  getState().setStatus('idle');
  getState().updateBroker({ clientId: 'tablet-test', demoMode: false });
  // Un test può sovrascrivere il valore: qui torna quello di default.
  getState().setTopologySyncSettings({ debounceMs: DEBOUNCE });
});

afterEach(() => {
  pushSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('useTopologySync · evento MQTT', () => {
  it('accorpa una raffica di eventi in un solo refetch, con toast', async () => {
    const { invalidate } = renderSync();

    act(() => {
      emitTopologyChanged(eventOf());
      emitTopologyChanged(eventOf({ id: 'kitchen' }));
      emitTopologyChanged(
        eventOf({ event: 'device_created', entity: 'device', id: 'lampada-studio' }),
      );
    });

    // Niente refetch finché la finestra di debounce è aperta.
    expect(invalidate).not.toHaveBeenCalled();

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: TOPOLOGY_QUERY_KEY });
    // Anche la planimetria annidata è topologia: stessa finestra di debounce.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: FLOORPLAN_QUERY_KEY });
    // Dopo il refetch i nuovi state_topic vengono sottoscritti.
    await waitFor(() => expect(mocks.refreshSubscriptions).toHaveBeenCalledTimes(1));
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'info', title: 'Topologia aggiornata in tempo reale' }),
    );
  });

  it('ignora l\'evento generato da questo stesso pannello', async () => {
    const { invalidate } = renderSync();

    act(() => {
      emitTopologyChanged(eventOf({ sourceClientId: 'tablet-test' }));
    });
    await sleep(DEBOUNCE + 100);
    expect(invalidate).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();

    // Un altro client, invece, deve invalidare.
    act(() => {
      emitTopologyChanged(eventOf({ sourceClientId: 'pc-direzione' }));
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('alla riconnessione forza un refetch di sicurezza senza toast', async () => {
    const { invalidate } = renderSync();
    const { getState } = useHomeStore;

    // Avvio: il primo CONNACK non deve generare un refetch inutile.
    act(() => getState().setStatus('connecting'));
    act(() => getState().setStatus('connected'));
    await sleep(DEBOUNCE + 100);
    expect(invalidate).not.toHaveBeenCalled();

    // blackout → rientro: durante il silenzio possono essere persi eventi.
    act(() => getState().setStatus('offline'));
    act(() => getState().setStatus('connected'));

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: TOPOLOGY_QUERY_KEY });
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('rispetta il debounce scelto da Impostazioni', async () => {
    useHomeStore.getState().setTopologySyncSettings({ debounceMs: 700 });
    const { invalidate } = renderSync();

    act(() => {
      emitTopologyChanged(eventOf());
    });

    // Oltre il default (300 ms) ma ancora dentro i 700 ms configurati.
    await sleep(DEBOUNCE + 150);
    expect(invalidate).not.toHaveBeenCalled();

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: TOPOLOGY_QUERY_KEY });
  });

  it('un evento ancora in coda non invalida dopo lo smontaggio', async () => {
    const { unmount, invalidate } = renderSync();

    act(() => {
      emitTopologyChanged(eventOf());
    });
    unmount();

    await sleep(DEBOUNCE + 100);
    expect(invalidate).not.toHaveBeenCalled();
    expect(mocks.refreshSubscriptions).not.toHaveBeenCalled();
  });
});

describe('useTopologySync · ripiego SSE', () => {
  it('apre lo stream col broker spento e ne smista gli eventi', async () => {
    const { invalidate } = renderSync();

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/topology/events');
    // I cookie di sessione devono accompagnare la richiesta cross-path.
    expect(source.init?.withCredentials).toBe(true);

    act(() => {
      source.message(
        JSON.stringify({
          event: 'room_updated',
          entity: 'room',
          id: 'living',
          timestamp: Date.now(),
          sourceClientId: 'pc-direzione',
        }),
      );
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: TOPOLOGY_QUERY_KEY });
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('chiude lo stream appena il broker MQTT torna connesso', () => {
    renderSync();
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => useHomeStore.getState().setStatus('connected'));

    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    // Tornato MQTT non deve restare un secondo canale aperto.
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('alla riapertura dello stream forza il refetch di sicurezza senza toast', async () => {
    const { invalidate } = renderSync();
    const first = FakeEventSource.instances[0]!;

    // Prima apertura: la topologia è appena arrivata dalla gate, niente refetch.
    act(() => first.open());
    await sleep(DEBOUNCE + 100);
    expect(invalidate).not.toHaveBeenCalled();

    // Broker di nuovo vivo → SSE chiuso, poi di nuovo in caduta → nuovo stream.
    act(() => useHomeStore.getState().setStatus('connected'));
    act(() => useHomeStore.getState().setStatus('offline'));
    const reopened = FakeEventSource.instances.at(-1)!;
    expect(reopened).not.toBe(first);
    expect(reopened.closed).toBe(false);

    act(() => reopened.open());

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
