import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

describe('controlli · modalità alto contrasto', () => {
  it('espone track, range e thumb dello slider con i data-slot del tema', () => {
    render(<Slider defaultValue={[40]} aria-label="Luminosità" />);

    const thumb = screen.getByRole('slider', { name: 'Luminosità' });
    // Radix avvolge il thumb in uno span di posizionamento: il Root è il nonno.
    const root = thumb.parentElement?.parentElement;
    expect(root).not.toBeNull();

    expect(root?.querySelector('[data-slot="slider-track"]')).not.toBeNull();
    expect(root?.querySelector('[data-slot="slider-range"]')).not.toBeNull();
    expect(thumb).toHaveAttribute('data-slot', 'slider-thumb');
  });

  it('distingue ON e OFF anche con indicatori di forma, non solo colore', () => {
    render(
      <>
        <Switch checked aria-label="Lampada accesa" />
        <Switch checked={false} aria-label="Presa spenta" />
      </>,
    );

    const on = screen.getByRole('switch', { name: 'Lampada accesa' });
    const off = screen.getByRole('switch', { name: 'Presa spenta' });

    expect(on).toHaveAttribute('data-state', 'checked');
    expect(on).toHaveAttribute('data-slot', 'switch-track');
    expect(off).toHaveAttribute('data-state', 'unchecked');

    const onIndicators = on.querySelectorAll('[data-slot="switch-indicator"]');
    expect(onIndicators).toHaveLength(2);
    onIndicators.forEach((indicator) => {
      expect(indicator).toHaveAttribute('aria-hidden', 'true');
    });

    // L'indicatore `|` compare solo in ON, il cerchio `O` solo in OFF: le
    // classi group-data sono l'unico switch visivo tra i due stati.
    expect(onIndicators[0]?.className).toContain('group-data-[state=checked]:opacity-100');
    expect(onIndicators[1]?.className).toContain('group-data-[state=checked]:opacity-0');
    expect(off.querySelectorAll('[data-slot="switch-indicator"]')).toHaveLength(2);
  });
});
