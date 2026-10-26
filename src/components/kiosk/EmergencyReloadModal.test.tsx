import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { EmergencyReloadModal } = await import('@/components/kiosk/EmergencyReloadModal');
const { useEmergencyReloadStore } = await import('@/store/emergencyReloadStore');
const { useHomeStore } = await import('@/store/homeStore');

beforeEach(() => {
  localStorage.clear();
  useEmergencyReloadStore.setState({
    frozen: false,
    blackoutSince: null,
    reloadAt: null,
    remainingSeconds: null,
    cancelled: false,
    retryHandler: null,
    cancelHandler: null,
  });
  useHomeStore.setState({
    connection: {
      ...useHomeStore.getState().connection,
      status: 'connected',
      lastNetworkActivityAt: Date.now(),
      frozenSince: null,
    },
  });
});

describe('EmergencyReloadModal', () => {
  it('non rende nulla quando non c’è un countdown attivo', () => {
    render(<EmergencyReloadModal />);
    expect(screen.queryByTestId('emergency-reload-modal')).not.toBeInTheDocument();
  });

  it('mostra il countdown e i due pulsanti quando il blackout persiste', () => {
    useEmergencyReloadStore.setState({
      blackoutSince: Date.now() - 600_000,
      reloadAt: Date.now() + 30_000,
      remainingSeconds: 30,
    });
    render(<EmergencyReloadModal />);

    expect(screen.getByTestId('emergency-reload-modal')).toBeInTheDocument();
    expect(screen.getByTestId('emergency-countdown')).toHaveTextContent('30');
    expect(screen.getByText('Annulla Riavvio')).toBeInTheDocument();
    expect(screen.getByText('Riprova Ora')).toBeInTheDocument();
    // Il messaggio cita i minuti di blackout.
    expect(screen.getByText(/da 10 minuti/)).toBeInTheDocument();
  });

  it('si nasconde dopo l\'annullo e chiama il handler del watchdog', async () => {
    const user = userEvent.setup();
    const cancelHandler = vi.fn();
    useEmergencyReloadStore.setState({
      blackoutSince: Date.now() - 600_000,
      reloadAt: Date.now() + 30_000,
      remainingSeconds: 30,
      cancelHandler,
    });
    render(<EmergencyReloadModal />);

    await user.click(screen.getByText('Annulla Riavvio'));

    expect(cancelHandler).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('emergency-reload-modal')).not.toBeInTheDocument();
  });

  it('"Riprova Ora" invoca il retry registrato dal watchdog', async () => {
    const user = userEvent.setup();
    const retryHandler = vi.fn();
    useEmergencyReloadStore.setState({
      blackoutSince: Date.now() - 600_000,
      reloadAt: Date.now() + 30_000,
      remainingSeconds: 30,
      retryHandler,
    });
    render(<EmergencyReloadModal />);

    await user.click(screen.getByText('Riprova Ora'));

    expect(retryHandler).toHaveBeenCalledTimes(1);
  });

  it('risveglia il dimmer kiosk quando il countdown parte', () => {
    const woken: string[] = [];
    const listener = (event: Event) => woken.push(event.type);
    window.addEventListener('domus:kiosk-wake', listener);

    act(() => {
      useEmergencyReloadStore.setState({
        blackoutSince: Date.now() - 600_000,
        reloadAt: Date.now() + 30_000,
        remainingSeconds: 30,
      });
    });
    render(<EmergencyReloadModal />);

    expect(woken).toContain('domus:kiosk-wake');
    window.removeEventListener('domus:kiosk-wake', listener);
  });

  it('mostra lo stato congelato quando la socket è zombie', () => {
    useHomeStore.setState({
      connection: {
        ...useHomeStore.getState().connection,
        status: 'stale',
        frozenSince: Date.now() - 600_000,
      },
    });
    useEmergencyReloadStore.setState({
      blackoutSince: Date.now() - 600_000,
      reloadAt: Date.now() + 30_000,
      remainingSeconds: 30,
    });
    render(<EmergencyReloadModal />);

    expect(screen.getByText(/socket sembra aperta/)).toBeInTheDocument();
  });
});
