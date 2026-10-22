import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePixelShift, type PixelShiftOptions } from '@/hooks/usePixelShift';

interface ProbeProps extends Omit<PixelShiftOptions, 'targetRef' | 'random'> {
  random?: () => number;
}

function Probe({ random = Math.random, ...options }: ProbeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const shift = usePixelShift({ ...options, targetRef: ref, random });
  return (
    <div ref={ref} data-testid="probe" data-x={shift.offset.x} data-y={shift.offset.y} style={shift.style} />
  );
}

const probe = () => document.querySelector<HTMLElement>('[data-testid="probe"]');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePixelShift · subtle-shift', () => {
  it('sposta solo con transform, a ogni intervallo', () => {
    render(<Probe mode="subtle-shift" intervalMs={60_000} amplitudePx={3} random={() => 0} />);

    const element = probe();
    expect(element?.style.transform).toBe('translate3d(0px, 0px, 0)');
    // Nessuna proprietà di layout animata.
    expect(element?.style.top).toBe('');
    expect(element?.style.left).toBe('');
    expect(element?.style.margin).toBe('');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(element?.dataset.x).toBe('-3');
    expect(element?.dataset.y).toBe('-3');
    expect(element?.style.transform).toBe('translate3d(-3px, -3px, 0)');
    expect(element?.style.transition).toContain('transform 1500ms cubic-bezier');
  });

  it('torna a zero senza animazione quando viene disattivato', () => {
    const { rerender } = render(
      <Probe mode="subtle-shift" intervalMs={1_000} random={() => 1} />,
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(probe()?.dataset.x).toBe('3');

    rerender(<Probe mode="subtle-shift" intervalMs={1_000} random={() => 1} enabled={false} />);

    expect(probe()?.style.transform).toBe('translate3d(0px, 0px, 0)');
    expect(probe()?.style.transition).toBe('none');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('usePixelShift · screensaver-float', () => {
  it('parte centrato e poi usa coordinate bounds-safe ricavate dal viewport', () => {
    render(<Probe mode="screensaver-float" intervalMs={30_000} random={() => 0} />);

    // jsdom: viewport 1024×768, elemento 0×0, margine 32.
    expect(probe()?.dataset).toMatchObject({ x: '512', y: '384' });
    expect(probe()?.style.transition).toBe('none');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(probe()?.dataset).toMatchObject({ x: '32', y: '32' });
    expect(probe()?.style.transition).toContain('transform 1500ms');
  });

  it('non si muove quando la scheda non è visibile', () => {
    render(<Probe mode="screensaver-float" intervalMs={1_000} random={() => 0} />);
    const center = probe()?.dataset.x;

    const spy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden' as DocumentVisibilityState);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(probe()?.dataset.x).toBe(center);
    spy.mockRestore();
  });
});

describe('usePixelShift · cleanup', () => {
  it('azzera i timer allo smontaggio, in entrambe le modalità', () => {
    const subtle = render(<Probe mode="subtle-shift" intervalMs={1_000} />);
    expect(vi.getTimerCount()).toBe(1);
    subtle.unmount();
    expect(vi.getTimerCount()).toBe(0);

    const float = render(<Probe mode="screensaver-float" intervalMs={1_000} />);
    expect(vi.getTimerCount()).toBe(1);
    float.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
