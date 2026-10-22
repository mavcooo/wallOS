import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KioskDimmerOverlay } from '@/components/kiosk/KioskDimmerOverlay';

function clock() {
  return screen.getByTestId('kiosk-dimmer-clock');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('KioskDimmerOverlay · burn-in', () => {
  it('quando è nascosto non intercetta tocchi e tiene l’orologio a zero', () => {
    render(<KioskDimmerOverlay visible={false} />);

    const overlay = screen.getByTestId('kiosk-dimmer-overlay');
    expect(overlay).toHaveClass('pointer-events-none', 'opacity-0');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(clock().style.transform).toBe('translate3d(0px, 0px, 0)');
    // Solo il fade dell'opacità: il ritorno in posizione è istantaneo.
    expect(clock().style.transition).toBe('opacity 900ms ease-out');
  });

  it('da visibile usa l’opacità configurata e parte centrato', () => {
    render(<KioskDimmerOverlay visible clockOpacity={0.35} mode="screensaver-float" />);

    const overlay = screen.getByTestId('kiosk-dimmer-overlay');
    expect(overlay).toHaveClass('opacity-100');
    expect(overlay).toHaveAttribute('aria-hidden', 'false');
    expect(clock().style.opacity).toBe('0.35');
    // jsdom: 1024×768, margine 32 → centro.
    expect(clock().style.transform).toBe('translate3d(512px, 384px, 0)');
  });

  it('sposta l’orologio a ogni intervallo con una transizione lenta', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(
      <KioskDimmerOverlay visible shiftIntervalMs={30_000} transitionMs={1_500} />,
    );

    expect(clock().style.transform).toBe('translate3d(512px, 384px, 0)');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(clock().style.transform).toBe('translate3d(32px, 32px, 0)');
    expect(clock().style.transition).toContain('transform 1500ms');
    expect(clock().style.transition).toContain('opacity 900ms');
    // Solo transform: niente top/left inline.
    expect(clock().style.top).toBe('');
    expect(clock().style.left).toBe('');
  });

  it('con mode subtle-shift oscilla di pochi pixel', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    render(<KioskDimmerOverlay visible mode="subtle-shift" shiftIntervalMs={60_000} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(clock().style.transform).toBe('translate3d(3px, 3px, 0)');
  });

  it('al risveglio torna subito in posizione e ferma i timer', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { rerender } = render(<KioskDimmerOverlay visible shiftIntervalMs={30_000} />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(clock().style.transform).not.toBe('translate3d(0px, 0px, 0)');

    rerender(<KioskDimmerOverlay visible={false} shiftIntervalMs={30_000} />);

    expect(clock().style.transform).toBe('translate3d(0px, 0px, 0)');
    expect(clock().style.transition).not.toContain('transform');
  });

  it('non lascia timer attivi allo smontaggio', () => {
    const { unmount } = render(<KioskDimmerOverlay visible shiftIntervalMs={30_000} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
