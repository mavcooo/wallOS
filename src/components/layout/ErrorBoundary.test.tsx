import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/components/layout/ErrorBoundary';

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

let reload: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
  // React logga ogni errore intercettato: nei test è rumore atteso.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reload = vi.fn();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.restoreAllMocks();
});

describe('ErrorBoundary · schermata diagnostica', () => {
  it('sostituisce il sottoalbero con messaggio, stack e pulsante di ricarica', () => {
    render(
      <ErrorBoundary>
        <Boom message="esplosione di test" />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('error-boundary-message')).toHaveTextContent(
      'Error: esplosione di test',
    );
    // Stack espandibile (`<details>`), non nascosto in console.
    expect(screen.getByText('Dettagli tecnici (stack trace)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ricarica Dashboard' })).toBeInTheDocument();
  });

  it('il pulsante grande ricarica la dashboard', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Boom message="ricarica" />
      </ErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: 'Ricarica Dashboard' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('senza errori rende i figli senza schermata diagnostica', () => {
    render(
      <ErrorBoundary>
        <p>dashboard</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });

  it('normalizza un valore lanciato che non è un Error', () => {
    function ThrowString(): never {
      // Simula una libreria che fa `throw 'boom'` invece di un Error.
      throw 'boom';
    }

    render(
      <ErrorBoundary>
        <ThrowString />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary-message')).toHaveTextContent('Error: boom');
  });
});
