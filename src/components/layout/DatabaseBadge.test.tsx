import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { DatabaseBadge } from '@/components/layout/DatabaseBadge';
import { useDatabaseHealthStore } from '@/store/databaseHealthStore';

beforeEach(() => {
  useDatabaseHealthStore.setState({
    status: 'checking',
    version: null,
    latencyMs: null,
    error: null,
    checkedAt: null,
  });
});

describe('DatabaseBadge', () => {
  it('mostra la versione quando il database è disponibile', () => {
    useDatabaseHealthStore.setState({
      status: 'up',
      version: 'PostgreSQL 17.4',
      latencyMs: 9,
      error: null,
      checkedAt: Date.now(),
    });

    render(<DatabaseBadge />);

    const badge = screen.getByRole('status', { name: 'Database disponibile, PG 17.4, 9 ms' });
    expect(badge).toHaveTextContent('PG 17.4');
    expect(screen.getByTestId('database-badge-detail')).toHaveTextContent('9 ms');
    expect(badge).toHaveAttribute('title', expect.stringContaining('PostgreSQL 17.4'));
    expect(badge).toHaveAttribute('title', expect.stringContaining('9 ms'));
  });

  it('senza latenza misurabile non aggiunge il separatore', () => {
    useDatabaseHealthStore.setState({
      status: 'up',
      version: 'PostgreSQL 17.4',
      latencyMs: null,
      error: null,
      checkedAt: Date.now(),
    });

    render(<DatabaseBadge />);

    expect(screen.getByRole('status')).toHaveTextContent('PG 17.4');
    expect(screen.queryByTestId('database-badge-detail')).toBeNull();
  });

  it('passa a “DB offline” quando il polling segnala un errore', () => {
    useDatabaseHealthStore.setState({
      status: 'up',
      version: 'PostgreSQL 17.4',
      latencyMs: 4,
      error: null,
      checkedAt: Date.now(),
    });

    render(<DatabaseBadge />);
    act(() => {
      useDatabaseHealthStore.setState({
        status: 'down',
        version: null,
        latencyMs: 1_500,
        error: 'ECONNREFUSED',
        checkedAt: Date.now(),
      });
    });

    expect(screen.getByText('DB offline')).toBeInTheDocument();
    // Il codice errore arriva da /api/health e resta visibile nel badge:
    // sul pannello touch il `title` non è leggibile.
    expect(screen.getByTestId('database-badge-detail')).toHaveTextContent('ECONNREFUSED');
    expect(
      screen.getByRole('status', { name: 'Database non raggiungibile (ECONNREFUSED)' }),
    ).toHaveAttribute('title', expect.stringContaining('ECONNREFUSED'));
  });

  it('mostra lo stato di verifica prima del primo esito', () => {
    render(<DatabaseBadge />);

    expect(screen.getByText('DB…')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Verifica del database in corso' })).toBeInTheDocument();
  });
});
