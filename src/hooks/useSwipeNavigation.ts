import { useRef } from 'react';
import {
  useSwipeable,
  type SwipeableHandlers,
  type SwipeEventData,
} from 'react-swipeable';

/**
 * Soglia (px) sotto la quale un movimento orizzontale resta un tap. 60 px
 * evita cambi pagina durante un tocco rapido o una piccola oscillazione del dito.
 */
export const SWIPE_DELTA_PX = 60;

/**
 * Elementi che non devono mai innescare la navigazione: slider Radix, manopole
 * clima, campi di testo, pulsanti, link, tab e contenitori marcati `ignore-swipe`.
 */
export const SWIPE_IGNORE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'a[href]',
  '[role="slider"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  '.ignore-swipe',
  '[data-swipe-ignore]',
].join(',');

export interface SwipeNavigationOptions<T> {
  /** Sequenza lungo cui navigare (pagine consentite o stanze visibili). */
  items: readonly T[];
  /** Elemento corrente; se assente dalla lista lo swipe è disabilitato. */
  current: T;
  onChange(next: T): void;
  /** Spegne del tutto la gesture (es. dentro RoomsPage vince il carosello stanze). */
  enabled?: boolean;
  /** Soglia in px; default 60, consigliato 50–75 su tablet a parete. */
  delta?: number;
  /** Solo tocco reale; `true` solo per test manuali su desktop. */
  trackMouse?: boolean;
  /** Blocca lo scroll del browser durante lo swipe orizzontale. */
  preventScrollOnSwipe?: boolean;
  /** Durata massima del gesto in ms (evita swipe lenti e accidentali). */
  swipeDurationMs?: number;
  /** Override del selettore di esclusione. */
  ignoreSelector?: string;
  /** Fine corsa: l'utente ha swipato oltre la prima o l'ultima voce. */
  onEdge?(edge: 'start' | 'end'): void;
  /** Callback dopo una navigazione effettiva (utile per la direzione animazione). */
  onSwipe?(direction: 'left' | 'right', data: SwipeEventData): void;
}

export interface SwipeNavigation {
  /** Da spalmare sull'elemento contenitore: include il `ref` che registra i touch. */
  handlers: SwipeableHandlers;
  currentIndex: number;
  canGoNext: boolean;
  canGoPrevious: boolean;
}

/** True se il gesto è partito da un controllo interattivo o da un'area esclusa. */
export function isSwipeIgnored(
  target: EventTarget | null,
  selector: string = SWIPE_IGNORE_SELECTOR,
): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as Element;
  if (typeof element.closest !== 'function') return false;
  return element.closest(selector) !== null;
}

/**
 * Navigazione orizzontale touch per kiosk.
 *
 * - swipe verso sinistra → voce successiva; verso destra → precedente;
 * - agli estremi non si cambia pagina: viene chiamato `onEdge` (feedback bounce);
 * - i gesti che nascono su slider/manopole/pulsanti sono ignorati, così il
 *   dimmer e il termostato continuano a funzionare;
 * - `trackMouse` è spento di default: sui tablet rispondono solo i touch.
 *
 * Il hook non tocca lo store: `onChange` collega la voce corrente a `setView`,
 * `setRoom` o a qualunque altro stato di navigazione.
 */
export function useSwipeNavigation<T>({
  items,
  current,
  onChange,
  enabled = true,
  delta = SWIPE_DELTA_PX,
  trackMouse = false,
  preventScrollOnSwipe = true,
  swipeDurationMs = 800,
  ignoreSelector = SWIPE_IGNORE_SELECTOR,
  onEdge,
  onSwipe,
}: SwipeNavigationOptions<T>): SwipeNavigation {
  const blockedRef = useRef(false);
  // La posizione resta valida anche con la gesture spenta: serve ai dots per
  // indicare dove ci si trova (es. pagina "Stanze" con swipe pagina disattivo).
  const index = items.indexOf(current);
  const currentIndex = index;
  const canGoNext = enabled && index >= 0 && index < items.length - 1;
  const canGoPrevious = enabled && index > 0;

  const handlers = useSwipeable({
    // La soglia vale per tutti i gesti: niente navigazione sotto i 60 px.
    delta,
    trackMouse,
    preventScrollOnSwipe,
    swipeDuration: swipeDurationMs,
    onSwipeStart: (data) => {
      // Il controllo da cui parte il gesto decide: slider e manopole vincono.
      blockedRef.current = !enabled || isSwipeIgnored(data.event.target, ignoreSelector);
    },
    // Con la gesture spenta i callback non vengono proprio registrati: niente
    // preventDefault sul pan orizzontale di slider e manopole.
    onSwipedLeft:
      enabled && index >= 0
        ? (data) => {
            if (blockedRef.current) return;
            const next = items[index + 1];
            if (next === undefined) {
              onEdge?.('end');
              return;
            }
            onChange(next);
            onSwipe?.('left', data);
          }
        : undefined,
    onSwipedRight:
      enabled && index >= 0
        ? (data) => {
            if (blockedRef.current) return;
            const previous = items[index - 1];
            if (previous === undefined) {
              onEdge?.('start');
              return;
            }
            onChange(previous);
            onSwipe?.('right', data);
          }
        : undefined,
  });

  return { handlers, currentIndex, canGoNext, canGoPrevious };
}
