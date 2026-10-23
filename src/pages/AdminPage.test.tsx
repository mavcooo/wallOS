import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/adminApi', () => ({
  adminApi: {
    createRoom: vi.fn(),
    updateRoom: vi.fn(),
    deleteRoom: vi.fn(),
    createDevice: vi.fn(),
    updateDevice: vi.fn(),
    deleteDevice: vi.fn(),
    createScenario: vi.fn(),
    updateScenario: vi.fn(),
    deleteScenario: vi.fn(),
  },
}));

vi.mock('@/lib/topologyApi', () => ({
  fetchTopology: vi.fn(),
}));

const { AdminPage } = await import('@/pages/AdminPage');
const { adminApi } = await import('@/lib/adminApi');
const { fetchTopology } = await import('@/lib/topologyApi');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useHomeStore.getState().hydrateTopology(SEED_TOPOLOGY);
  vi.mocked(fetchTopology).mockResolvedValue(SEED_TOPOLOGY);
});

describe('AdminPage · gestione topologia', () => {
  it('elenca stanze, dispositivi e scenari letti dal database', async () => {
    render(<AdminPage />);

    expect(screen.getByText('Soggiorno')).toBeInTheDocument();
    expect(screen.getByText(/living · \d+ dispositivi/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Dispositivi/ }));
    expect(screen.getByText('Luce principale')).toBeInTheDocument();
    expect(screen.getByText(/light-living-main/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Scenari/ }));
    expect(screen.getByText('Cinema')).toBeInTheDocument();
  });

  it('crea una stanza con id derivato dal nome e ricarica la topologia', async () => {
    vi.mocked(adminApi.createRoom).mockResolvedValue({
      room: { id: 'garage', label: 'Garage', shortLabel: 'Garage', icon: 'home', displayOrder: 0 },
    });

    render(<AdminPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Nuova stanza' }));

    const name = await screen.findByLabelText('Nome');
    await userEvent.type(name, 'Garage');

    expect(screen.getByDisplayValue('garage')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Crea stanza' }));

    await waitFor(() =>
      expect(adminApi.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'garage', name: 'Garage' }),
      ),
    );
    await waitFor(() => expect(fetchTopology).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('compone i passi di scenario con l’editor visuale, senza JSON', async () => {
    vi.mocked(adminApi.createScenario).mockResolvedValue({
      scenario: {
        id: 'test-scena',
        label: 'Test scena',
        description: '',
        icon: 'sparkles',
        protected: false,
        steps: [{ deviceId: 'light-living-main', action: { type: 'brightness', brightness: 20 } }],
        displayOrder: 0,
      },
    });

    render(<AdminPage />);
    await userEvent.click(screen.getByRole('tab', { name: /Scenari/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Nuovo scenario' }));

    const name = await screen.findByLabelText('Nome');
    await userEvent.type(name, 'Test scena');

    expect(screen.queryByRole('textbox', { name: /Azioni/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi passo' }));
    expect(screen.getByLabelText('Dispositivo passo 1')).toHaveValue('light-living-main');

    await userEvent.selectOptions(screen.getByLabelText('Azione passo 1'), 'brightness');
    const value = screen.getByLabelText('Valore passo 1');
    await userEvent.clear(value);
    await userEvent.type(value, '20');

    await userEvent.click(screen.getByRole('button', { name: 'Crea scenario' }));

    await waitFor(() =>
      expect(adminApi.createScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-scena',
          label: 'Test scena',
          actions: [
            { deviceId: 'light-living-main', action: { type: 'brightness', brightness: 20 } },
          ],
        }),
      ),
    );
  });

  it('mostra l’errore del server quando la stanza non è vuota', async () => {
    vi.mocked(adminApi.deleteRoom).mockRejectedValue(
      new Error('La stanza contiene 3 dispositivi: spostali o eliminali prima'),
    );

    render(<AdminPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Elimina Soggiorno' }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('contiene 3 dispositivi');
    expect(adminApi.deleteRoom).toHaveBeenCalledWith('living');
  });
});
