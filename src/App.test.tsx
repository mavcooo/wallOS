import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/healthApi', () => ({
  fetchDatabaseHealth: vi.fn().mockResolvedValue({
    status: 'up',
    version: 'PostgreSQL 17.4',
    latencyMs: 3,
    error: null,
  }),
}));

vi.mock('@/lib/authApi', () => {
  class ApiError extends Error {
    status = 401;
    code = 'UNAUTHENTICATED';
  }

  return {
    ApiError,
    authApi: {
      me: vi.fn().mockRejectedValue(new ApiError('Sessione scaduta')),
      refresh: vi.fn().mockResolvedValue(null),
      login: vi.fn(),
      kioskSession: vi.fn(),
      logout: vi.fn(),
      verifyPin: vi.fn(),
      changePin: vi.fn(),
      switchProfile: vi.fn(),
      listUsers: vi.fn(),
      setUserActive: vi.fn(),
    },
  };
});

vi.mock('@/lib/topologyApi', async () => {
  const { SEED_TOPOLOGY } = await import('@/test/fixtures');
  return { fetchTopology: vi.fn().mockResolvedValue(SEED_TOPOLOGY) };
});

vi.mock('@/mqtt/MqttProvider', () => ({
  MqttProvider: ({ children }: { children: unknown }) => children,
  useMqttApi: () => ({ sendAction: vi.fn(), runScenario: vi.fn() }),
}));

const { default: App } = await import('@/App');
const { useAuthStore } = await import('@/store/authStore');
const { useHomeStore } = await import('@/store/homeStore');

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ status: 'loading', user: null, elevated: false });
});

describe('App', () => {
  it('senza sessione mostra il lock screen e non monta la shell con lo swipe', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'DOMUS' })).toBeInTheDocument();
    expect(screen.queryByTestId('page-swipe-dots')).not.toBeInTheDocument();
  });

  it('lo swipe orizzontale cambia pagina e sincronizza header e Sidebar', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      elevated: false,
      user: {
        id: 'u-admin',
        username: 'admin',
        name: 'Amministratore',
        initials: 'AM',
        role: 'admin',
        allowedRooms: null,
        active: true,
        isKioskDevice: false,
        kioskDeviceId: null,
        lastAccess: null,
        pinLength: 4,
      },
    });

    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Overview' }),
    ).toBeInTheDocument();
    // La pagina è un chunk lazy: il contenuto deve comparire dopo lo shell.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Scenari rapidi' }),
    ).toBeInTheDocument();

    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    fireEvent.touchStart(main as Element, {
      touches: [{ clientX: 260, clientY: 200, identifier: 1 }],
    });
    fireEvent.touchMove(main as Element, {
      touches: [{ clientX: 100, clientY: 200, identifier: 1 }],
    });
    fireEvent.touchEnd(main as Element, { touches: [] });

    expect(useHomeStore.getState().ui.view).toBe('rooms');
    expect(await screen.findByRole('heading', { level: 1, name: 'Stanze' })).toBeInTheDocument();
    const active = document.querySelector(
      'nav[aria-label="Navigazione"] button[aria-current="page"]',
    );
    expect(active?.textContent).toContain('Stanze');
  });

  it('sotto i 768px monta la Bottom Navigation al posto della Sidebar', async () => {
    // jsdom non applica i breakpoint Tailwind: qui conta il gate JS della
    // shell, che sostituisce davvero un albero di navigazione con l'altro.
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media.includes('max-width: 767px'),
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));

    try {
      useAuthStore.setState({
        status: 'authenticated',
        elevated: false,
        user: {
          id: 'u-admin',
          username: 'admin',
          name: 'Amministratore',
          initials: 'AM',
          role: 'admin',
          allowedRooms: null,
          active: true,
          isKioskDevice: false,
          kioskDeviceId: null,
          lastAccess: null,
          pinLength: 4,
        },
      });

      render(<App />);

      expect(await screen.findByTestId('bottom-nav')).toBeInTheDocument();
      expect(screen.queryByTestId('app-sidebar')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Stanze' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Stanze' })).toBeInTheDocument();
      expect(useHomeStore.getState().ui.view).toBe('rooms');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
