import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chunkRows,
  resolveColumns,
  VirtualizedDeviceGrid,
  DEFAULT_ESTIMATED_CARD_HEIGHT,
} from '@/components/ui/VirtualizedDeviceGrid';

/** Card finta: il test misura la griglia, non i widget reali. */
vi.mock('@/components/widgets/DeviceCard', () => ({
  DeviceCard: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="card" data-device-id={deviceId} />
  ),
}));

const VIEWPORT_HEIGHT = 600;
const VIEWPORT_WIDTH = 1200;
const ROW_HEIGHT = 180;

function rect(height: number, width = VIEWPORT_WIDTH, top = 0): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    width,
    height,
    right: width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Contenitore scroll con viewport simulata: jsdom non fa layout e il
 * virtualizer legge `clientWidth`/`clientHeight`, non il bounding rect.
 */
function createScroller(): HTMLDivElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true });
  Object.defineProperty(element, 'clientWidth', { value: VIEWPORT_WIDTH, configurable: true });
  element.getBoundingClientRect = () => rect(VIEWPORT_HEIGHT);
  document.body.append(element);
  return element;
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `device-${index}`);
}

function mountedIds(): string[] {
  return screen.getAllByTestId('card').map((node) => node.dataset.deviceId ?? '');
}

beforeEach(() => {
  // jsdom non fa layout: la griglia legge `getBoundingClientRect` per la
  // larghezza e TanStack misura le righe con `offsetHeight`. Senza questi
  // stub le altezze sarebbero 0 e la virtualizzazione non avrebbe range.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect(ROW_HEIGHT));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(ROW_HEIGHT);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(VIEWPORT_WIDTH);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('resolveColumns', () => {
  it('applica le soglie responsive alla larghezza del contenitore', () => {
    const spec = { sm: 2, md: 2, xl: 3 };
    expect(resolveColumns(320, spec)).toBe(1);
    expect(resolveColumns(700, spec)).toBe(2);
    expect(resolveColumns(1200, spec)).toBe(2);
    expect(resolveColumns(1600, spec)).toBe(3);
  });

  it('accetta un numero fisso e non scende mai sotto una colonna', () => {
    expect(resolveColumns(100, 4)).toBe(4);
    expect(resolveColumns(100, 0)).toBe(1);
  });
});

describe('chunkRows', () => {
  it('raggruppa gli id in righe complete e un eventuale resto', () => {
    expect(chunkRows(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(chunkRows([], 3)).toEqual([]);
  });
});

describe('VirtualizedDeviceGrid', () => {
  it('monta solo le righe visibili con 100 device', () => {
    const scroller = createScroller();

    render(
      <VirtualizedDeviceGrid
        deviceIds={ids(100)}
        columnsCount={3}
        estimatedCardHeight={DEFAULT_ESTIMATED_CARD_HEIGHT}
        scrollElement={scroller}
      />,
    );

    const mounted = mountedIds();
    // 4 righe visibili circa + 2 di overscan, 3 colonne: mai le 100 card.
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(24);
    expect(mounted).toContain('device-0');
    expect(mounted).not.toContain('device-99');
  });

  it('monta le card successive quando si scrolla', () => {
    const scroller = createScroller();

    render(
      <VirtualizedDeviceGrid deviceIds={ids(100)} columnsCount={3} scrollElement={scroller} />,
    );

    expect(mountedIds()).not.toContain('device-60');

    scroller.scrollTop = 4_000;
    fireEvent.scroll(scroller);

    const mounted = mountedIds();
    expect(mounted).not.toContain('device-0');
    expect(mounted.some((id) => Number(id.replace('device-', '')) >= 30)).toBe(true);
  });

  it('compensa l’offset della griglia nel contenitore scrollabile', () => {
    const scroller = createScroller();
    // La griglia comincia 500 px sotto l'inizio del contenuto di <main>.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const isGrid = this instanceof HTMLElement && this.dataset.virtualized !== undefined;
      return rect(isGrid ? ROW_HEIGHT : 0, VIEWPORT_WIDTH, isGrid ? 500 : 0);
    });
    scroller.scrollTop = 500;

    render(
      <VirtualizedDeviceGrid deviceIds={ids(100)} columnsCount={3} scrollElement={scroller} />,
    );

    // Viewport 500–1100 del contenuto = riga 0 della griglia: senza
    // `scrollMargin` TanStack partirebbe dalla riga 2 e mostrerebbe device-6.
    const firstRow = document.querySelector('[data-index="0"]') as HTMLElement | null;
    expect(firstRow).not.toBeNull();
    expect(firstRow?.style.transform).toBe('translate3d(0, 0px, 0)');
    expect(mountedIds()).toContain('device-0');
  });

  it('il numero di nodi resta costante al crescere del dataset', () => {
    const small = createScroller();
    const { unmount } = render(
      <VirtualizedDeviceGrid deviceIds={ids(20)} columnsCount={3} scrollElement={small} />,
    );
    const smallCount = mountedIds().length;
    unmount();
    small.remove();

    const large = createScroller();
    render(
      <VirtualizedDeviceGrid deviceIds={ids(200)} columnsCount={3} scrollElement={large} />,
    );
    const largeCount = mountedIds().length;

    // 200 device non montano più nodi di 20: la finestra è la stessa.
    expect(largeCount).toBe(smallCount);
    expect(largeCount).toBeLessThanOrEqual(24);
  });

  it('mostra il placeholder con dataset vuoto', () => {
    const scroller = createScroller();
    render(
      <VirtualizedDeviceGrid
        deviceIds={[]}
        scrollElement={scroller}
        emptyPlaceholder={<p>Nessun preferito</p>}
      />,
    );
    expect(screen.getByText('Nessun preferito')).toBeInTheDocument();
    expect(screen.queryAllByTestId('card')).toHaveLength(0);
  });

  it('senza contenitore scroll rende tutte le card (fallback statico)', () => {
    render(<VirtualizedDeviceGrid deviceIds={ids(12)} columnsCount={2} />);
    expect(screen.getAllByTestId('card')).toHaveLength(12);
    expect(document.querySelector('[data-virtualized]')).toHaveAttribute(
      'data-virtualized',
      'static',
    );
  });
});
