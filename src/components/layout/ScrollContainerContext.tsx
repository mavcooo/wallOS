import { createContext, useContext, type ReactNode, type RefObject } from 'react';

/**
 * Ponte tra `<main>` di AppShell e i contenitori virtualizzati.
 *
 * Nel kiosk l'unico elemento che scrolla è `<main>` (`.kiosk-scroll`), non il
 * `window`: `useVirtualizer` ha bisogno di quel riferimento esatto per
 * calcolare la finestra visibile. Il provider passa solo una `ref` (nessuno
 * stato), quindi i figli possono leggerla nei loro effetti già al primo mount,
 * quando l'elemento è montato ma nessun re-render è ancora avvenuto.
 */
export interface ScrollContainerContextValue {
  ref: RefObject<HTMLElement | null>;
  /**
   * Versione del layout della pagina. Ogni griglia virtuale la incrementa
   * quando la propria altezza totale cambia (misurazioni, cambio colonne):
   * le griglie successive riescono così a ricalcolare il proprio offset.
   */
  revision: number;
  notifyLayoutChange(): void;
}

const ScrollContainerContext = createContext<ScrollContainerContextValue | null>(null);

export function ScrollContainerProvider({
  value,
  children,
}: {
  value: ScrollContainerContextValue;
  children: ReactNode;
}) {
  return (
    <ScrollContainerContext.Provider value={value}>
      {children}
    </ScrollContainerContext.Provider>
  );
}

/** `null` fuori da AppShell (test isolati, Storybook): la griglia è statica. */
export function useScrollContainerContext(): ScrollContainerContextValue | null {
  return useContext(ScrollContainerContext);
}
