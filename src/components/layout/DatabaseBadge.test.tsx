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

    const badge = screen.getByRole('status', { name: 'Database disponibile, PG 17.4' });
    expect(badge).toHaveAttribute('title', expect.stringContaining('PostgreSQL 17.4'));
    expect(badge).toHaveAttribute('title', expect.stringContaining('9 ms'));
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
    expect(screen.getByRole('status', { name: 'Database non raggiungibile' })).toHaveAttribute(
      'title',
      expect.stringContaining('ECONNREFUSED'),
    );
  });

  it('mostra lo stato di verifica prima del primo esito', () => {
    render(<DatabaseBadge />);

    expect(screen.getByText('DB…')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Verifica del database in corso' })).toBeInTheDocument();
  });
});
