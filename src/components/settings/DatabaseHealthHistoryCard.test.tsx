import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseHealthHistoryCard } from '@/components/settings/DatabaseHealthHistoryCard';
import i18n from '@/i18n';
import { createTestQueryClient } from '@/test/query';
import { useDatabaseHealthStore } from '@/store/databaseHealthStore';

const RECORDS = [
  {
    id: '3',
    status: 'down',
    latencyMs: 5000,
    checkedAt: '2026-10-29T08:15:42.000Z',
    errorMessage: 'ECONNREFUSED',
  },
  {
    id: '2',
    status: 'degraded',
    latencyMs: 640,
    checkedAt: '2026-10-29T08:15:12.000Z',
    errorMessage: null,
  },
  {
    id: '1',
    status: 'healthy',
    latencyMs: 12,
    checkedAt: '2026-10-29T08:14:42.000Z',
    errorMessage: null,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderCard() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DatabaseHealthHistoryCard />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('it');
  useDatabaseHealthStore.setState({
    status: 'checking',
    version: null,
    latencyMs: null,
    error: null,
    checkedAt: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DatabaseHealthHistoryCard', () => {
  it('mostra stato, latenza, timestamp ed errore dei controlli', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(RECORDS)));

    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId('database-history-list')).toBeInTheDocument(),
    );
    expect(screen.getAllByTestId('database-history-row')).toHaveLength(3);

    expect(screen.getByText('Down')).toBeInTheDocument();
    expect(screen.getByText('Lento')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('640 ms')).toBeInTheDocument();
    expect(screen.getByText(/Errore: ECONNREFUSED/)).toBeInTheDocument();
    // Timestamp compatto richiesto dal pannello: HH:mm:ss - DD/MM.
    expect(screen.getAllByText(/\d{2}:\d{2}:\d{2} - \d{2}\/\d{2}/)).toHaveLength(3);
    expect(screen.queryByTestId('database-history-loading')).not.toBeInTheDocument();
  });

  it('mostra un empty state chiaro invece di uno spinner infinito', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));

    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId('database-history-empty')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Nessun controllo registrato/)).toBeInTheDocument();
    expect(screen.queryByTestId('database-history-loading')).not.toBeInTheDocument();
  });

  it('durante un down conserva l’ultimo storico e mostra l’avviso', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(RECORDS))
      .mockResolvedValue(jsonResponse({ message: 'Errore nel recupero dello storico DB' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    renderCard();
    await waitFor(() =>
      expect(screen.getAllByTestId('database-history-row')).toHaveLength(3),
    );

    // Il monitor di `/api/health` ha rilevato il down: la card resta popolata.
    useDatabaseHealthStore.setState({
      status: 'down',
      error: 'ECONNREFUSED',
      checkedAt: Date.now(),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna storico' }));

    await waitFor(() =>
      expect(screen.getByTestId('database-history-alert')).toHaveTextContent(
        /Database non raggiungibile: mostro l’ultimo storico salvato/,
      ),
    );
    expect(screen.getAllByTestId('database-history-row')).toHaveLength(3);
    expect(screen.getByTestId('database-history-alert')).toHaveTextContent(
      /Ultimo codice errore: ECONNREFUSED/,
    );
  });
});
