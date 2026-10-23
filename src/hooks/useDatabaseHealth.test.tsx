import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { useDatabaseHealthMonitor } from '@/hooks/useDatabaseHealth';
import { useToastStore, type Toast } from '@/store/toastStore';

function healthResponse(status: 'up' | 'down', version = 'PostgreSQL 17.4'): Response {
  return new Response(
    JSON.stringify({
      status: status === 'up' ? 'ok' : 'degraded',
      database: {
        status,
        ...(status === 'up'
          ? { version, latencyMs: 2 }
          : { error: 'ECONNREFUSED', latencyMs: 1_500 }),
      },
    }),
    {
      status: status === 'up' ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function Probe({ intervalMs = 20 }: { intervalMs?: number }) {
  const state = useDatabaseHealthMonitor({ intervalMs, timeoutMs: 2_000 });
  return (
    <span data-testid="health">
      {state.status}:{state.version ?? '-'}
    </span>
  );
}

let push: MockInstance<(toast: Omit<Toast, 'id'>) => void>;

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  push = vi.spyOn(useToastStore.getState(), 'push');
});

afterEach(() => {
  push.mockRestore();
  vi.unstubAllGlobals();
});

describe('useDatabaseHealthMonitor', () => {
  it('notifica il down una sola volta e il recupero al ritorno online', async () => {
    const responses = [
      healthResponse('up'),
      healthResponse('down'),
      healthResponse('down'),
      healthResponse('up', 'PostgreSQL 17.4'),
    ];
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(responses.shift() ?? healthResponse('up')),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('health')).toHaveTextContent('down:-'));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Database non raggiungibile', tone: 'error' }),
      ),
    );

    await waitFor(() =>
      expect(screen.getByTestId('health')).toHaveTextContent('up:PostgreSQL 17.4'),
    );
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Database di nuovo disponibile', tone: 'success' }),
      ),
    );

    const downToasts = push.mock.calls.filter(
      ([toast]) => toast.title === 'Database non raggiungibile',
    );
    expect(downToasts).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/health');
  });

  it('non notifica quando il database è disponibile fin dal primo controllo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(healthResponse('up'))),
    );

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('health')).toHaveTextContent('up:PostgreSQL'));

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(push).not.toHaveBeenCalled();
  });

  it('smette di interrogare il gateway dopo lo smontaggio', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(healthResponse('up')));
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    view.unmount();
    const callsAtUnmount = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(fetchMock.mock.calls.length).toBe(callsAtUnmount);
  });
});
