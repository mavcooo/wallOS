import { useEffect, useState } from 'react';

/**
 * Intervallo dei viewport "compatti": smartphone verticali e tablet in
 * portrait stretto. Coincide con il breakpoint `md` di Tailwind (768px), così
 * CSS e JavaScript raccontano la stessa storia.
 */
export const COMPACT_VIEWPORT_QUERY = '(max-width: 767px)';

/**
 * Sotto i 768px la shell passa da Sidebar laterale a Bottom Navigation Bar.
 *
 * Il valore iniziale è calcolato in modo sincrono: al primo paint il layout è
 * già quello giusto (niente rail laterale che scompare dopo un frame). Se
 * `matchMedia` non esiste — jsdom nei test, browser molto vecchi — resta
 * `false`, cioè layout desktop: la shell non dipende dalla feature per
 * funzionare.
 *
 * Il listener risponde anche a rotazione del tablet e ridimensionamento della
 * finestra: sidebar e bottom bar non convivono mai nello stesso albero.
 */
export function useCompactViewport(): boolean {
  const [compact, setCompact] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const sync = () => setCompact(query.matches);
    // Ri-allineamento dopo il mount: copre un cambio di viewport avvenuto fra
    // il render iniziale e l'effetto.
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return compact;
}
