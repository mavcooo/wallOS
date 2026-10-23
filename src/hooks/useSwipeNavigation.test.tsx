import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { isSwipeIgnored, useSwipeNavigation, type SwipeNavigationOptions } from './useSwipeNavigation';

function Harness({
  current,
  onChange,
  enabled,
  trackMouse,
  onEdge,
}: {
  current: string;
  onChange(next: string): void;
  enabled?: boolean;
  trackMouse?: boolean;
  onEdge?: SwipeNavigationOptions<string>['onEdge'];
}) {
  const { handlers } = useSwipeNavigation<string>({
    items: ['a', 'b', 'c'],
    current,
    onChange,
    enabled,
    trackMouse,
    onEdge,
  });

  return (
    <div data-testid="surface" {...handlers}>
      <div data-testid="plain">Contenuto</div>
      <div data-testid="dimmer" className="ignore-swipe">
        <span data-testid="thumb">thumb</span>
      </div>
      <button type="button" data-testid="button">
        Tap
      </button>
    </div>
  );
}

function gesture(
  target: Element,
  fromX: number,
  toX: number,
  fromY = 100,
  toY = 100,
): void {
  fireEvent.touchStart(target, {
    touches: [{ clientX: fromX, clientY: fromY, identifier: 1 }],
  });
  fireEvent.touchMove(target, {
    touches: [{ clientX: toX, clientY: toY, identifier: 1 }],
  });
  fireEvent.touchEnd(target, { touches: [] });
}

describe('useSwipeNavigation', () => {
  it('swipe a sinistra va alla voce successiva, a destra alla precedente', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Harness current="b" onChange={onChange} />);

    gesture(screen.getByTestId('plain'), 220, 100);
    expect(onChange).toHaveBeenLastCalledWith('c');

    rerender(<Harness current="b" onChange={onChange} />);
    gesture(screen.getByTestId('plain'), 100, 220);
    expect(onChange).toHaveBeenLastCalledWith('a');
  });

  it('ignora i movimenti sotto la soglia di 60 px', () => {
    const onChange = vi.fn();
    render(<Harness current="b" onChange={onChange} />);

    gesture(screen.getByTestId('plain'), 200, 165);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('non naviga partendo da slider/manopole o da pulsanti (ignore-swipe)', () => {
    const onChange = vi.fn();
    render(<Harness current="b" onChange={onChange} />);

    gesture(screen.getByTestId('dimmer'), 220, 100);
    gesture(screen.getByTestId('thumb'), 220, 100);
    gesture(screen.getByTestId('button'), 220, 100);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('segnala il fine corsa senza cambiare voce', () => {
    const onChange = vi.fn();
    const onEdge = vi.fn();
    const { rerender } = render(
      <Harness current="a" onChange={onChange} onEdge={onEdge} />,
    );

    gesture(screen.getByTestId('plain'), 100, 220);
    expect(onEdge).toHaveBeenLastCalledWith('start');
    expect(onChange).not.toHaveBeenCalled();

    rerender(<Harness current="c" onChange={onChange} onEdge={onEdge} />);
    gesture(screen.getByTestId('plain'), 220, 100);
    expect(onEdge).toHaveBeenLastCalledWith('end');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('non considera gli swipe verticali', () => {
    const onChange = vi.fn();
    render(<Harness current="b" onChange={onChange} />);

    gesture(screen.getByTestId('plain'), 200, 205, 200, 80);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('con enabled=false la gesture è completamente spenta', () => {
    const onChange = vi.fn();
    const onEdge = vi.fn();
    render(<Harness current="a" onChange={onChange} onEdge={onEdge} enabled={false} />);

    gesture(screen.getByTestId('plain'), 100, 220);

    expect(onChange).not.toHaveBeenCalled();
    expect(onEdge).not.toHaveBeenCalled();
  });

  it('trackMouse è spento di default e attivabile per i test desktop', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Harness current="b" onChange={onChange} />);
    const surface = screen.getByTestId('surface');

    fireEvent.mouseDown(surface, { clientX: 220 });
    fireEvent.mouseMove(surface, { clientX: 100 });
    fireEvent.mouseUp(surface, { clientX: 100 });
    expect(onChange).not.toHaveBeenCalled();

    rerender(<Harness current="b" onChange={onChange} trackMouse />);
    fireEvent.mouseDown(screen.getByTestId('surface'), { clientX: 220 });
    fireEvent.mouseMove(screen.getByTestId('surface'), { clientX: 100 });
    fireEvent.mouseUp(screen.getByTestId('surface'), { clientX: 100 });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('preventScrollOnSwipe blocca il pan orizzontale ma lascia lo scroll verticale', () => {
    render(<Harness current="b" onChange={vi.fn()} />);
    const surface = screen.getByTestId('surface');

    fireEvent.touchStart(surface, {
      touches: [{ clientX: 200, clientY: 200, identifier: 1 }],
    });
    const verticalMove = fireEvent.touchMove(surface, {
      touches: [{ clientX: 204, clientY: 80, identifier: 1 }],
    });
    fireEvent.touchEnd(surface, { touches: [] });
    expect(verticalMove).toBe(true);

    fireEvent.touchStart(surface, {
      touches: [{ clientX: 200, clientY: 200, identifier: 1 }],
    });
    const horizontalMove = fireEvent.touchMove(surface, {
      touches: [{ clientX: 80, clientY: 200, identifier: 1 }],
    });
    expect(horizontalMove).toBe(false);
  });

  it('riconosce i controlli interattivi da escludere', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'ignore-swipe';
    const child = document.createElement('span');
    wrapper.appendChild(child);

    expect(isSwipeIgnored(child)).toBe(true);
    expect(isSwipeIgnored(document.createElement('div'))).toBe(false);
    expect(isSwipeIgnored(null)).toBe(false);
    expect(isSwipeIgnored(child, '.altro-selettore')).toBe(false);
  });
});
