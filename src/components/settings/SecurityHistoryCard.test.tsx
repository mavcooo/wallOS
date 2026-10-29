import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecurityHistoryCard } from '@/components/settings/SecurityHistoryCard';
import i18n from '@/i18n';
import type { SecurityEventRecord } from '@/lib/securityApi';
import { createTestQueryClient } from '@/test/query';

const OPEN_EVENT: SecurityEventRecord = {
  id: '7',
  deviceId: 'sensor-kitchen-smoke',
  deviceName: 'Sensore fumo',
  roomId: 'kitchen',
  roomName: 'Cucina',
  zoneId: 'emergency',
  eventType: 'smoke',
  severity: 'critical',
  payload: null,
  triggeredAt: '2026-10-29T08:15:00.000Z',
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  notes: null,
};

const RESOLVED_EVENT: SecurityEventRecord = {
  ...OPEN_EVENT,
  id: '6',
  eventType: 'tamper',
  severity: 'info',
  triggeredAt: '2026-10-28T19:05:00.000Z',
  acknowledgedAt: '2026-10-28T19:06:00.000Z',
  resolvedAt: '2026-10-28T19:10:00.000Z',
  notes: 'Falso contatto, finestra chiusa',
};

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => (request: { onConfirm: () => void }) => request.onConfirm(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderCard() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SecurityHistoryCard />
    </QueryClientProvider>,
  );
}

let requests: string[] = [];

beforeEach(async () => {
  await i18n.changeLanguage('it');
  requests = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SecurityHistoryCard', () => {
  it('mostra eventi aperti e risolti con nota e timbri', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        requests.push(String(input));
        return jsonResponse({ events: [OPEN_EVENT, RESOLVED_EVENT], hasMore: false, nextCursor: null });
      }),
    );

    renderCard();

    await waitFor(() => expect(screen.getAllByTestId('security-history-row')).toHaveLength(2));

    expect(screen.getByText('Fumo rilevato')).toBeInTheDocument();
    expect(screen.getByText('Intrusione rilevata')).toBeInTheDocument();
    expect(screen.getByText('Aperto')).toBeInTheDocument();
    expect(screen.getByText('Risolto')).toBeInTheDocument();
    expect(screen.getByText(/Nota: Falso contatto, finestra chiusa/)).toBeInTheDocument();
    // Il periodo di default è 7 giorni: il server riceve un confine ISO.
    expect(requests[0]).toContain('from=');

    // Solo l'evento aperto espone i controlli di risoluzione.
    expect(screen.getAllByRole('button', { name: 'Risolvi' })).toHaveLength(1);
  });

  it('cambia intervallo e severità rifacendo la query con i filtri', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      requests.push(String(input));
      return jsonResponse({ events: [], hasMore: false, nextCursor: null });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCard();
    await waitFor(() => expect(screen.getByTestId('security-history-empty')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '24 ore' }));
    await waitFor(() => expect(requests.some((url) => url.includes('from='))).toBe(true));

    fireEvent.change(screen.getByRole('combobox', { name: 'Severità' }), {
      target: { value: 'critical' },
    });
    await waitFor(() => expect(requests.some((url) => url.includes('severity=critical'))).toBe(true));
  });

  it('risolve un allarme con la nota scritta dal pannello', async () => {
    const posted: { url: string; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (init?.method === 'POST') {
          posted.push({ url, body: String(init.body ?? '') });
          return jsonResponse({
            event: { ...OPEN_EVENT, resolvedAt: '2026-10-29T09:00:00.000Z' },
            state: { status: 'DISARMED' },
          });
        }
        return jsonResponse({ events: [OPEN_EVENT], hasMore: false, nextCursor: null });
      }),
    );

    renderCard();
    await waitFor(() => expect(screen.getAllByTestId('security-history-row')).toHaveLength(1));

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Nota di risoluzione per l\'evento 7' }),
      { target: { value: 'Fumo rientrato dopo areazione' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Risolvi' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.url).toContain('/api/security/events/7/resolve');
    expect(posted[0]?.body).toContain('Fumo rientrato dopo areazione');
  });
});
