import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useScrollContainerContext } from '@/components/layout/ScrollContainerContext';
import { DeviceCard } from '@/components/widgets/DeviceCard';
import { cn } from '@/lib/utils';

/**
 * Griglia di card virtualizzata per kiosk a risorse limitate.
 *
 * Il DOM non cresce con il numero di device: la griglia raggruppa gli id in
 * righe da N colonne e monta solo le righe che intersecano la viewport (più
 * `overscan` righe di prerender). Le card restano `DeviceCard`, quindi ognuna
 * continua a sottoscrivere solo la propria riga di `homeStore`: un payload
 * MQTT non ridisegna la griglia né le card vicine.
 *
 * Note di implementazione:
 * - la virtualizzazione è **row-based**: la larghezza del contenitore decide
 *   le colonne, le righe sono l'unità virtuale;
 * - le righe sono posizionate in assoluto con `translate3d` (compositing GPU)
 *   e misurate via `ResizeObserver` interno di TanStack, così altezze diverse
 *   (luce con slider, clima, telecamera) non si sovrappongono;
 * - `minHeight` pari all'altezza stimata evita collapse e jitter al primo
 *   scroll: la stima è il pavimento, la misura reale entra solo se più alta.
 */

export interface ColumnBreakpoints {
  sm?: number;
  md?: number;
  lg?: number;
  xl?: number;
}

export interface VirtualizedDeviceGridProps {
  /** Id nel nuovo ordine: la griglia non riceve metadati né telemetria. */
  deviceIds: readonly string[];
  /** Numero fisso di colonne oppure soglie responsive (default `{ sm: 2, xl: 3 }`). */
  columnsCount?: number | ColumnBreakpoints;
  /** Altezza minima/stimata della card in px, base per l'anti-layout-shift. */
  estimatedCardHeight?: number;
  /** Righe prerenderizzate fuori viewport (default 2). */
  overscan?: number;
  /** Gap in px tra card e tra righe (default 12). */
  gap?: number;
  emptyPlaceholder?: ReactNode;
  showFavorite?: boolean;
  className?: string;
  /**
   * Contenitore scroll alternativo (test o pannelli annidati). Con `null` la
   * griglia rende statica, utile quando non esiste una viewport misurabile.
   */
  scrollElement?: HTMLElement | null;
}

/** Soglie minime dei breakpoint Tailwind usati per le colonne. */
const BREAKPOINTS = [
  ['sm', 640],
  ['md', 768],
  ['lg', 1024],
  ['xl', 1280],
] as const satisfies readonly (readonly [keyof ColumnBreakpoints, number])[];

export const DEFAULT_COLUMNS: ColumnBreakpoints = { sm: 2, xl: 3 };

export const DEFAULT_ESTIMATED_CARD_HEIGHT = 200;

export const DEFAULT_GRID_GAP = 12;

export const DEFAULT_OVERSCAN_ROWS = 2;

/** Colonne effettive per una larghezza in px (mai meno di una). */
export function resolveColumns(
  width: number,
  spec: number | ColumnBreakpoints = DEFAULT_COLUMNS,
): number {
  if (typeof spec === 'number') return Math.max(1, Math.round(spec));
  let columns = 1;
  for (const [key, minWidth] of BREAKPOINTS) {
    if (width >= minWidth) columns = Math.max(1, spec[key] ?? columns);
  }
  return columns;
}

/** Righe di `columns` id: l'unità che la virtualizzazione monta e misura. */
export function chunkRows<T>(items: readonly T[], columns: number): T[][] {
  const size = Math.max(1, columns);
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

export function VirtualizedDeviceGrid({
  deviceIds,
  columnsCount = DEFAULT_COLUMNS,
  estimatedCardHeight = DEFAULT_ESTIMATED_CARD_HEIGHT,
  overscan = DEFAULT_OVERSCAN_ROWS,
  gap = DEFAULT_GRID_GAP,
  emptyPlaceholder = null,
  showFavorite = false,
  className,
  scrollElement,
}: VirtualizedDeviceGridProps) {
  const scrollContext = useScrollContainerContext();
  const rootRef = useRef<HTMLDivElement>(null);

  // Fuori da AppShell (test, Storybook) non c'è una viewport scrollabile:
  // meglio una griglia statica corretta che una lista vuota.
  const hasScrollSource = scrollElement !== undefined ? scrollElement !== null : scrollContext !== null;
  const [staticMode, setStaticMode] = useState(!hasScrollSource);

  const getScrollElement = useCallback((): HTMLElement | null => {
    if (scrollElement !== undefined) return scrollElement;
    return scrollContext?.ref.current ?? null;
  }, [scrollElement, scrollContext]);

  // Larghezza reale del contenitore: ResizeObserver copre rotazione tablet e
  // cambio di sidebar, il primo rect copre il mount (observer asincrono).
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => {
      const next = element.getBoundingClientRect().width;
      setWidth((previous) => (Math.abs(previous - next) > 0.5 ? next : previous));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const columns = resolveColumns(width, columnsCount);
  const rows = useMemo(() => chunkRows(deviceIds, columns), [deviceIds, columns]);

  // Offset della griglia rispetto all'origine del contenuto scrollabile:
  // senza `scrollMargin` la virtualizzazione userebbe il top di <main> e
  // monterebbe righe sbagliate quando la griglia sta sotto KPI e header.
  const [scrollMargin, setScrollMargin] = useState(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize: () => estimatedCardHeight + gap,
    overscan,
    scrollMargin,
  });

  // Se non arriva mai un contenitore scroll (mount isolato), degrada a statico
  // prima di dipingere una lista vuota.
  useLayoutEffect(() => {
    if (!getScrollElement()) setStaticMode(true);
  }, [getScrollElement]);

  useLayoutEffect(() => {
    if (staticMode) return;
    const scroller = getScrollElement();
    const list = rootRef.current;
    if (!scroller || !list) return;
    const margin = Math.max(
      0,
      list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
    );
    setScrollMargin((previous) => (Math.abs(previous - margin) > 0.5 ? margin : previous));
  }, [staticMode, getScrollElement, scrollContext?.revision, width, columns]);

  // Colonne o stima cambiate: le posizioni assolute vanno ricalcolate (lo
  // `scrollMargin`, invece, entra già nella memo delle misurazioni).
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, columns, estimatedCardHeight]);

  const totalSize = virtualizer.getTotalSize();

  // Una griglia che cambia altezza sposta quelle sotto: avvisa le altre.
  const lastTotalSize = useRef(totalSize);
  useEffect(() => {
    if (lastTotalSize.current === totalSize) return;
    lastTotalSize.current = totalSize;
    scrollContext?.notifyLayoutChange();
  }, [totalSize, scrollContext]);

  if (deviceIds.length === 0) return <>{emptyPlaceholder}</>;

  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    columnGap: gap,
    minHeight: estimatedCardHeight,
  } as const;

  return (
    <div
      ref={rootRef}
      data-virtualized={staticMode ? 'static' : 'rows'}
      style={{ touchAction: 'pan-y' }}
      className={cn('relative w-full', className)}
    >
      {staticMode ? (
        <div style={{ ...gridStyle, rowGap: gap }}>
          {deviceIds.map((deviceId) => (
            <DeviceCard key={deviceId} deviceId={deviceId} showFavorite={showFavorite} />
          ))}
        </div>
      ) : (
        <div style={{ position: 'relative', width: '100%', height: Math.max(0, totalSize - gap) }}>
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                // `start` include lo scrollMargin: si riporta in coordinate
                // relative alla griglia prima di traslare la riga.
                transform: `translate3d(0, ${virtualRow.start - scrollMargin}px, 0)`,
                willChange: 'transform',
                // Il padding fa parte della riga misurata: il gap verticale
                // resta coerente anche con altezze eterogenee.
                paddingBottom: gap,
              }}
            >
              <div style={gridStyle}>
                {rows[virtualRow.index]?.map((deviceId) => (
                  <DeviceCard key={deviceId} deviceId={deviceId} showFavorite={showFavorite} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
