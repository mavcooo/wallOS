import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { SunlightModeCard } from '@/components/settings/SunlightModeCard';
import { useContrastStore } from '@/store/contrastStore';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-contrast');
  useContrastStore.setState({
    preference: 'auto',
    systemHighContrast: false,
    ambientLux: null,
    ambientSupported: false,
  });
});

describe('SunlightModeCard', () => {
  it('accende la modalità con lo switch e la salva come scelta manuale', async () => {
    render(<SunlightModeCard />);

    expect(screen.getByText('Disattivata')).toBeInTheDocument();
    expect(screen.getByTestId('contrast-reason')).toHaveTextContent(
      /Sensore di luce non disponibile/,
    );

    await userEvent.click(screen.getByRole('switch', { name: 'Modalità alto contrasto' }));

    expect(useContrastStore.getState().preference).toBe('on');
    expect(document.documentElement.dataset.contrast).toBe('high');
    expect(screen.getByText('Attiva')).toBeInTheDocument();
    expect(screen.getByTestId('contrast-reason')).toHaveTextContent(
      /Attivata manualmente/,
    );
  });

  it('torna in automatico e spiega la lettura del sensore', () => {
    useContrastStore.setState({ ambientSupported: true });
    render(<SunlightModeCard />);

    const automatic = screen.getByRole('button', { name: 'Automatica' });
    expect(automatic).toHaveAttribute('aria-pressed', 'true');

    act(() => {
      useContrastStore.getState().setAmbientLux(1_400);
    });

    expect(document.documentElement.dataset.contrast).toBe('high');
    expect(screen.getByTestId('contrast-reason')).toHaveTextContent(/1400 lux/);

    act(() => {
      useContrastStore.getState().setAmbientLux(200);
    });

    expect(screen.getByTestId('contrast-reason')).toHaveTextContent(/200 lux/);
    expect(document.documentElement.dataset.contrast).toBe('normal');
  });

  it('passa a “Mai” e ignora la luce ambientale', async () => {
    useContrastStore.setState({ ambientSupported: true, ambientLux: 1_600 });
    render(<SunlightModeCard />);

    expect(document.documentElement.dataset.contrast).toBe('high');

    await userEvent.click(screen.getByRole('button', { name: 'Mai' }));

    expect(useContrastStore.getState().preference).toBe('off');
    expect(document.documentElement.dataset.contrast).toBe('normal');
    expect(screen.getByRole('button', { name: 'Mai' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
