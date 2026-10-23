import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LightCard } from '@/components/widgets/LightCard';
import { useHomeStore } from '@/store/homeStore';
import { deviceOf, SEED_TOPOLOGY } from '@/test/fixtures';

const device = deviceOf('light-living-main', 'light');

beforeEach(() => {
  // L'etichetta della stanza arriva dallo store idratato dal server.
  useHomeStore.getState().hydrateTopology(SEED_TOPOLOGY);
});

describe('LightCard', () => {
  it('mostra stanza e intensità corrente', () => {
    render(<LightCard device={device} onAction={vi.fn()} />);

    expect(screen.getByText(device.name)).toBeInTheDocument();
    expect(screen.getByText('Soggiorno · 72%')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: `Accendi o spegni ${device.name}` })).toBeChecked();
  });

  it('con la luce spenta mostra “spenta” e disabilita i preset di colore', async () => {
    const off = deviceOf('light-living-ambient', 'light');
    const onAction = vi.fn();
    render(<LightCard device={off} onAction={onAction} />);

    expect(screen.getByText('Soggiorno · spenta')).toBeInTheDocument();
    for (const preset of ['Calda', 'Neutra', 'Fredda']) {
      expect(screen.getByRole('button', { name: preset })).toBeDisabled();
    }

    const toggle = screen.getByRole('switch', { name: `Accendi o spegni ${off.name}` });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'power', on: true });
  });

  it('invia la temperatura colore del preset selezionato', async () => {
    const onAction = vi.fn();
    render(<LightCard device={device} onAction={onAction} />);

    await userEvent.click(screen.getByRole('button', { name: 'Neutra' }));

    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'colorTemp', kelvin: 3500 });
  });

  it('invia la luminosità solo alla fine dello scorrimento dello slider', async () => {
    const onAction = vi.fn();
    render(<LightCard device={device} onAction={onAction} />);

    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '72');

    slider.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '73');
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'brightness', brightness: 73 });
  });
});
