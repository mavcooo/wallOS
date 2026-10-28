import { act, fireEvent, render, screen } from '@testing-library/react';
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
    expect(overlay).toHaveClass('pointer-events-none', 'invisible', 'opacity-0');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(clock().style.transform).toBe('translate3d(0px, 0px, 0)');
    // A fade concluso l'overlay esce dal paint; will-change torna ad auto.
    expect(overlay.style.transitionProperty).toBe('opacity, visibility');
    expect(overlay.style.transitionDelay).toBe('0ms, 900ms');
    expect(overlay.style.willChange).toBe('auto');
    // Solo il fade dell'opacità: il ritorno in posizione è istantaneo.
    expect(clock().style.transition).toBe('opacity 900ms ease-out');
  });

  it('da visibile usa l’opacità configurata e parte centrato', () => {
    render(<KioskDimmerOverlay visible clockOpacity={0.35} mode="screensaver-float" />);

    const overlay = screen.getByTestId('kiosk-dimmer-overlay');
    expect(overlay).toHaveClass('opacity-100');
    expect(overlay).toHaveAttribute('aria-hidden', 'false');
    expect(overlay.style.transitionDelay).toBe('0ms, 0ms');
    expect(overlay.style.willChange).toBe('opacity');
    expect(clock().style.willChange).toBe('transform, opacity');
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

describe('KioskDimmerOverlay · risveglio senza click-through', () => {
  it('blocca i gesti nativi sulla superficie nera', () => {
    render(<KioskDimmerOverlay visible />);

    // `touch-action: none` impedisce panning/pinch/doppio-tap-zoom, che
    // ruberebbero il pointerdown al risveglio.
    expect(screen.getByTestId('kiosk-dimmer-overlay').style.touchAction).toBe('none');
  });

  it('consuma il pointerdown e sveglia una sola volta', () => {
    const onWake = vi.fn();
    const bubbled = vi.fn();
    render(
      <div onPointerDown={bubbled}>
        <KioskDimmerOverlay visible onWake={onWake} />
      </div>,
    );
    const overlay = screen.getByTestId('kiosk-dimmer-overlay');

    // `dispatchEvent` restituisce false quando `preventDefault` è stato chiamato.
    expect(fireEvent.pointerDown(overlay)).toBe(false);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(bubbled).not.toHaveBeenCalled();
  });

  it('resta sopra al contenuto per tutta la dissolvenza', () => {
    const onWake = vi.fn();
    const { rerender } = render(
      <KioskDimmerOverlay visible onWake={onWake} fadeMs={900} />,
    );
    const overlay = screen.getByTestId('kiosk-dimmer-overlay');

    // Il tocco di risveglio: `visible` passa a false nel solito render.
    fireEvent.pointerDown(overlay);
    rerender(<KioskDimmerOverlay visible={false} onWake={onWake} fadeMs={900} />);

    // Durante il fade il layer è ancora opaco ai tocchi: i pointerup/click
    // residui atterrano qui, non sul widget che si trovava sotto.
    expect(overlay).toHaveClass('pointer-events-auto', 'opacity-0');
    expect(fireEvent.pointerDown(overlay)).toBe(false);
    // Già svegli: un secondo `wake` non deve partire.
    expect(onWake).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(900);
    });

    // A transizione conclusa l'overlay torna trasparente ai tocchi.
    expect(overlay).toHaveClass('pointer-events-none');
  });
});
