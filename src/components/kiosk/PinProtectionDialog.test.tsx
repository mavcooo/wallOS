import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PinProtectionDialog } from './PinProtectionDialog';
import {
  loadPinRateLimit,
  normalizePinRateLimitConfig,
  savePinRateLimit,
  type PinAttemptResponse,
} from '@/lib/pin';

function failure(remainingAttempts = 2): PinAttemptResponse {
  return {
    ok: false,
    locked: false,
    retryAfterMs: 0,
    remainingAttempts,
    lockedUntil: null,
  };
}

function enter(pin: string): void {
  for (const digit of pin) {
    fireEvent.click(screen.getByRole('button', { name: digit }));
  }
}

const BASE_PROPS = {
  open: true,
  title: 'Azione protetta',
  description: 'Conferma il PIN per continuare.',
  onOpenChange: () => {},
  onSuccess: () => {},
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('PinProtectionDialog', () => {
  it('mostra errore, tentativi residui e shake quando il PIN è errato', async () => {
    const verify = vi.fn().mockResolvedValue(failure(2));

    render(
      <PinProtectionDialog
        {...BASE_PROPS}
        scope="test-errore"
        maxAttempts={3}
        verify={verify}
        onSuccess={() => {}}
      />,
    );

    enter('1111');

    expect(await screen.findByText('PIN errato · 2 tentativi rimasti')).toBeInTheDocument();
    expect(verify).toHaveBeenCalledWith('1111');
    expect(screen.getByLabelText('PIN di 4 cifre')).toHaveClass('animate-shake');
    expect(screen.getByRole('button', { name: '1' })).toBeEnabled();
  });

  it('blocca tastierino e tastiera al terzo errore e persiste il lockout', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce(failure(2))
      .mockResolvedValueOnce(failure(1))
      .mockResolvedValue(failure(1));

    const { rerender } = render(
      <PinProtectionDialog
        {...BASE_PROPS}
        scope="test-lockout"
        maxAttempts={3}
        verify={verify}
        onSuccess={() => {}}
      />,
    );

    enter('1111');
    expect(await screen.findByText('PIN errato · 2 tentativi rimasti')).toBeInTheDocument();

    enter('1111');
    expect(await screen.findByText('PIN errato · 1 tentativo rimasto')).toBeInTheDocument();

    enter('1111');
    expect(await screen.findByText('Troppi tentativi errati')).toBeInTheDocument();
    expect(verify).toHaveBeenCalledTimes(3);

    expect(await screen.findByText('Troppi tentativi errati')).toBeInTheDocument();
    expect(screen.getByText(/Bloccato · riprova tra \d+s/)).toBeInTheDocument();

    const key = screen.getByRole('button', { name: '1' });
    expect(key).toBeDisabled();

    const calls = verify.mock.calls.length;
    fireEvent.click(key);
    fireEvent.keyDown(window, { key: '5' });
    fireEvent.keyDown(window, { key: 'Backspace' });
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(calls));

    const persisted = loadPinRateLimit(
      'test-lockout',
      normalizePinRateLimitConfig({ maxAttempts: 3 }),
    );
    expect(persisted.lockoutUntil).toBeGreaterThan(Date.now());

    // Chiudere e riaprire non azzera il blocco.
    rerender(
      <PinProtectionDialog
        {...BASE_PROPS}
        open={false}
        scope="test-lockout"
        maxAttempts={3}
        verify={verify}
        onSuccess={() => {}}
      />,
    );
    rerender(
      <PinProtectionDialog
        {...BASE_PROPS}
        scope="test-lockout"
        maxAttempts={3}
        verify={verify}
        onSuccess={() => {}}
      />,
    );

    expect(await screen.findByText('Troppi tentativi errati')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toBeDisabled();
  });

  it('riabilita il tastierino da solo quando il countdown arriva a zero', async () => {
    savePinRateLimit('test-countdown', {
      failures: 0,
      lockoutLevel: 1,
      lockoutUntil: Date.now() + 1_500,
    });

    render(
      <PinProtectionDialog
        {...BASE_PROPS}
        scope="test-countdown"
        maxAttempts={3}
        verify={vi.fn().mockResolvedValue(failure())}
        onSuccess={() => {}}
      />,
    );

    expect(await screen.findByText('Troppi tentativi errati')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toBeDisabled();

    expect(
      await screen.findByText('Inserisci il PIN di 4 cifre', undefined, { timeout: 4_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toBeEnabled();
  });

  it('accetta la tastiera fisica e invia il PIN al raggiungimento della lunghezza', async () => {
    const verify = vi.fn().mockResolvedValue({
      ok: true,
      locked: false,
      retryAfterMs: 0,
      remainingAttempts: 3,
      lockedUntil: null,
    } satisfies PinAttemptResponse);
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <PinProtectionDialog
        {...BASE_PROPS}
        scope="test-keyboard"
        maxAttempts={3}
        verify={verify}
        onSuccess={onSuccess}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyDown(window, { key: 'Backspace' });
    fireEvent.keyDown(window, { key: '3' });
    fireEvent.keyDown(window, { key: '4' });
    fireEvent.keyDown(window, { key: '5' });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('1345'));
    expect(verify).toHaveBeenCalledWith('1345');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
