import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PowerCard } from '@/components/widgets/PowerCard';
import { deviceOf } from '@/test/fixtures';

const device = deviceOf('power-kitchen-dishwasher', 'power');

describe('PowerCard', () => {
  it('mostra nome, consumi e carico del device', () => {
    render(<PowerCard device={device} onAction={vi.fn()} />);

    expect(screen.getByText(device.name)).toBeInTheDocument();
    // 1180 W → "1,18 kW"; 1180/2200 = 54% di carico.
    expect(screen.getByText('1,18 kW')).toBeInTheDocument();
    expect(screen.getByText('1,42 kWh oggi')).toBeInTheDocument();
    expect(screen.getByText('54% di 2,2 kW')).toBeInTheDocument();
    expect(screen.getByText('231 V · 5.1 A')).toBeInTheDocument();
  });

  it('manda il comando di spegnimento quando il device è acceso', async () => {
    const onAction = vi.fn();
    render(<PowerCard device={device} onAction={onAction} />);

    const toggle = screen.getByRole('switch', { name: `Alimenta ${device.name}` });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);

    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'power', on: false });
  });

  it('manda il comando di accensione quando il device è spento', async () => {
    const off = deviceOf('power-kitchen-oven', 'power');
    const onAction = vi.fn();
    render(<PowerCard device={off} onAction={onAction} />);

    const toggle = screen.getByRole('switch', { name: `Alimenta ${off.name}` });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'power', on: true });
  });

  it('il preferito è opzionale e, se presente, chiama il toggle', async () => {
    const onToggleFavorite = vi.fn();
    const { rerender } = render(<PowerCard device={device} onAction={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Aggiungi ai preferiti' })).not.toBeInTheDocument();

    rerender(
      <PowerCard device={device} onAction={vi.fn()} onToggleFavorite={onToggleFavorite} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi ai preferiti' }));
    expect(onToggleFavorite).toHaveBeenCalledOnce();
  });

  it('mostra l’indicatore di sincronizzazione solo con un comando in coda', () => {
    const { rerender } = render(<PowerCard device={device} onAction={vi.fn()} />);

    expect(
      screen.queryByLabelText('In attesa di sincronizzazione'),
    ).not.toBeInTheDocument();

    rerender(<PowerCard device={device} onAction={vi.fn()} pending />);

    expect(screen.getByLabelText('In attesa di sincronizzazione')).toBeInTheDocument();
  });
});
