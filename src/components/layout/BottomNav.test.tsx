import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { BottomNav } from '@/components/layout/BottomNav';
import i18n from '@/i18n';
import { useAuthStore } from '@/store/authStore';
import { useHomeStore } from '@/store/homeStore';
import type { SessionUser } from '@/types/user';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
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
    ...overrides,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('it');
  useAuthStore.setState({ status: 'authenticated', user: user(), elevated: false });
  useHomeStore.getState().setView('overview');
});

describe('BottomNav', () => {
  it('mostra le stesse voci della Sidebar con etichette compatte', () => {
    render(<BottomNav />);

    const nav = screen.getByTestId('bottom-nav');
    expect(nav).toHaveAttribute('aria-label', 'Navigazione');
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveTextContent('Home');
    expect(screen.getByRole('button', { name: 'Stanze' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Consumi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Impostazioni' })).toHaveTextContent('Setup');
    expect(screen.getByRole('button', { name: 'Utenti' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Amministrazione' })).toBeInTheDocument();
  });

  it('marca la vista attiva e cambia pagina al tocco', () => {
    render(<BottomNav />);

    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stanze' }));

    expect(useHomeStore.getState().ui.view).toBe('rooms');
    expect(screen.getByRole('button', { name: 'Stanze' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('disabilita le viste non consentite al profilo, spiegando il motivo', () => {
    useAuthStore.setState({
      status: 'authenticated',
      elevated: false,
      user: user({ id: 'u-kiosk', username: 'kiosk', name: 'Pannello', role: 'kiosk' }),
    });

    render(<BottomNav />);

    // Il kiosk non elevato consuma l'energia senza PIN, ma impostazioni, utenti
    // e amministrazione sono negate finché non si eleva il profilo.
    expect(screen.getByRole('button', { name: 'Consumi' })).toBeEnabled();
    const settings = screen.getByRole('button', { name: 'Impostazioni' });
    expect(settings).toBeDisabled();
    expect(settings).toHaveAttribute('title', 'Impostazioni non consentito per Pannello Parete');
    expect(screen.getByRole('button', { name: 'Utenti' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Amministrazione' })).toBeDisabled();
  });
});
