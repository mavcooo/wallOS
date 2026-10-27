import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KioskManagerTab } from '@/components/admin/KioskManagerTab';
import { kioskListQueryKey } from '@/hooks/useKioskProfile';
import i18n from '@/i18n';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import { createTestQueryClient } from '@/test/query';
import { useToastStore } from '@/store/toastStore';
import type { KioskDisplay } from '@/types/kiosk';

const ID = 'kiosk_5f0f2c1e-3c4a-4b6e-9a10-9a3f0f8a1b2c';

function display(overrides: Partial<KioskDisplay> = {}): KioskDisplay {
  return {
    id: ID,
    name: 'Pannello Ingresso',
    defaultRoomId: 'living',
    dimmerTimeoutSec: 300,
    dimmerScreensaverMode: 'clock_float',
    performanceMode: false,
    highContrast: false,
    pinRequired: true,
    screenOrientation: 'landscape',
    isActive: true,
    lastSeenAt: Date.now() - 30_000,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 60_000,
    online: true,
    ...overrides,
  };
}

function renderTab(displays: KioskDisplay[] = [display()]): void {
  const client = createTestQueryClient();
  client.setQueryData(kioskListQueryKey, displays);
  client.setQueryData(['topology'], SEED_TOPOLOGY);
  render(
    <QueryClientProvider client={client}>
      <KioskManagerTab />
    </QueryClientProvider>,
  );
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Server finto: il PUT risponde con il display aggiornato, la lista rifà il GET. */
function stubServer(displays: KioskDisplay[] = [display()]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });

      if (method === 'PUT') {
        const patch = JSON.parse(String(init?.body ?? '{}')) as Partial<KioskDisplay>;
        const current = { ...display(), ...patch, updatedAt: Date.now() };
        displays[0] = current;
        return new Response(JSON.stringify({ display: current }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ displays }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

beforeEach(async () => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  await i18n.changeLanguage('it');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('KioskManagerTab · elenco', () => {
  it('mostra nome, id, stato di presenza e timeout del pannello', () => {
    stubServer();
    renderTab();

    expect(screen.getByText('Pannello Ingresso')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(ID))).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('300 s')).toBeInTheDocument();
    expect(screen.getByText(/ultimo contatto/)).toBeInTheDocument();
  });

  it('distingue un pannello che non risponde da uno mai collegato', () => {
    stubServer();
    renderTab([
      display({ id: 'kiosk_offline', name: 'Cucina', online: false }),
      display({ id: 'kiosk_new', name: 'Studio', online: false, lastSeenAt: null }),
    ]);

    expect(screen.getAllByText('Offline')).toHaveLength(2);
    expect(screen.getByText(/mai collegato/)).toBeInTheDocument();
  });

  it('spiega quando non c’è ancora nessun display registrato', () => {
    stubServer([]);
    renderTab([]);

    expect(screen.getByText(/Nessun display si è ancora collegato/)).toBeInTheDocument();
  });
});

describe('KioskManagerTab · modifica', () => {
  it('salva il nome e mostra la conferma', async () => {
    const user = userEvent.setup();
    const calls = stubServer();
    renderTab();

    const nameInput = screen.getByDisplayValue('Pannello Ingresso');
    await user.clear(nameInput);
    await user.type(nameInput, 'Tablet Ingresso');
    await user.click(screen.getByRole('button', { name: /Salva/ }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.url).toContain(`/api/kiosk/${ID}`);
      expect((put?.body as { name?: string }).name).toBe('Tablet Ingresso');
    });
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((toast) => toast.title === 'Display aggiornato')).toBe(
        true,
      ),
    );
  });

  it('invia la configurazione senza modificarla per verificare il collegamento', async () => {
    const user = userEvent.setup();
    const calls = stubServer();
    renderTab();

    await user.click(screen.getByRole('button', { name: /Invia configurazione/ }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.body).toEqual({});
    });
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((toast) => toast.title === 'Configurazione inviata'),
      ).toBe(true),
    );
  });

  it('mostra l’errore del server senza perdere i valori del form', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: 'INVALID_BODY', message: 'Il timeout deve stare tra 30 e 600' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    renderTab();

    await user.click(screen.getByRole('button', { name: /Salva/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Il timeout deve stare tra 30 e 600',
    );
    expect(screen.getByDisplayValue('Pannello Ingresso')).toBeInTheDocument();
  });
});
