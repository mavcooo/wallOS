import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContrastToggle } from '@/components/settings/ContrastToggle';
import { useHighContrast } from '@/hooks/useHighContrast';
import {
  CONTRAST_STORAGE_KEY,
  persistContrastPreference,
  readContrastPreference,
} from '@/lib/contrast';
import { useContrastStore } from '@/store/contrastStore';

function resetContrast() {
  localStorage.clear();
  document.documentElement.removeAttribute('data-contrast');
  useContrastStore.setState({
    preference: 'auto',
    systemHighContrast: false,
    ambientLux: null,
    ambientSupported: false,
  });
}

/** jsdom non implementa matchMedia: stub minimo con emissione manuale. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches: initial,
    media: '(prefers-contrast: more)',
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    query,
    emit(matches: boolean) {
      query.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };
}

function Probe() {
  const { enabled, preference } = useHighContrast();
  return (
    <output data-testid="contrast-state">
      {enabled ? 'on' : 'off'}:{preference}
    </output>
  );
}

beforeEach(resetContrast);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useHighContrast', () => {
  it('attiva la modalità dal header, aggiorna <html> e la salva', async () => {
    render(<ContrastToggle />);

    const toggle = screen.getByRole('button', { name: 'Attiva alto contrasto' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement.dataset.contrast).toBe('normal');

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Disattiva alto contrasto' })).toBe(toggle);
    expect(document.documentElement.dataset.contrast).toBe('high');
    expect(localStorage.getItem(CONTRAST_STORAGE_KEY)).toBe('on');

    await userEvent.click(toggle);
    expect(useContrastStore.getState().preference).toBe('off');
    expect(document.documentElement.dataset.contrast).toBe('normal');
  });

  it('segue prefers-contrast: more quando la preferenza è automatica', () => {
    const media = installMatchMedia(false);

    render(<Probe />);
    expect(screen.getByTestId('contrast-state')).toHaveTextContent('off:auto');
    expect(document.documentElement.dataset.contrast).toBe('normal');

    act(() => media.emit(true));

    expect(screen.getByTestId('contrast-state')).toHaveTextContent('on:auto');
    expect(document.documentElement.dataset.contrast).toBe('high');

    act(() => media.emit(false));

    expect(screen.getByTestId('contrast-state')).toHaveTextContent('off:auto');
    expect(document.documentElement.dataset.contrast).toBe('normal');
  });

  it('accende la modalità oltre 1000 lux ma la scelta manuale vince', () => {
    render(<Probe />);

    act(() => useContrastStore.getState().setAmbientLux(1_400));
    expect(screen.getByTestId('contrast-state')).toHaveTextContent('on:auto');

    act(() => useContrastStore.getState().setAmbientLux(120));
    expect(screen.getByTestId('contrast-state')).toHaveTextContent('off:auto');

    act(() => {
      useContrastStore.getState().setAmbientLux(1_400);
      useContrastStore.getState().setPreference('off');
    });
    expect(screen.getByTestId('contrast-state')).toHaveTextContent('off:off');
    expect(document.documentElement.dataset.contrast).toBe('normal');
  });

  it('legge solo preferenze valide dal localStorage', () => {
    expect(readContrastPreference()).toBe('auto');

    persistContrastPreference('on');
    expect(readContrastPreference()).toBe('on');

    localStorage.setItem(CONTRAST_STORAGE_KEY, 'sunlight');
    expect(readContrastPreference()).toBe('auto');
  });
});
