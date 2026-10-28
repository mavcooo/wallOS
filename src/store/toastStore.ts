import { create } from 'zustand';

import { randomId } from '@/lib/randomId';

/** Tinta visiva dei toast non critici (compatibilità con le chiamate esistenti). */
export type ToastTone = 'success' | 'error' | 'info';

/**
 * Livello di allerta di una notifica.
 *
 * - `info`: feedback transitorio, sparisce da solo.
 * - `warning`: anomalia da vedere, auto-dismiss più lungo ma chiudibile a mano.
 * - `critical`: allarme di sicurezza, **non** sparisce mai da solo: resta a
 *   schermo finché l'utente non lo riconosce esplicitamente.
 */
export type ToastPriority = 'info' | 'warning' | 'critical';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  priority: ToastPriority;
  timestamp: number;
  /** Se true la tacitazione richiede la verifica del PIN. */
  requirePin?: boolean;
  /** Es. `{ type: 'smoke' | 'flood' | 'intrusion' | 'connection', sensorId, room }`. */
  metadata?: Record<string, unknown>;
  acknowledgedAt?: number;
  tone?: ToastTone;
}

/** Alias storico: diversi componenti importavano `Toast`. */
export type Toast = ToastMessage;

/** Payload accettato da `push`: `timestamp`/`priority` sono opzionali. */
export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  priority?: ToastPriority;
  timestamp?: number;
  requirePin?: boolean;
  metadata?: Record<string, unknown>;
  durationMs?: number;
}

interface ToastState {
  /** Notifiche attive, nell'ordine di arrivo. */
  toasts: ToastMessage[];
  /** Allarmi critici già riconosciuti: log diagnostico in memoria. */
  history: ToastMessage[];
  /** true quando l'utente ha tacitato la sirena dell'allarme corrente. */
  alarmSilenced: boolean;
  /**
   * Accoda una notifica e restituisce il suo id.
   *
   * `info`/`warning` si rimuovono da sole; `critical` resta finché non viene
   * chiamata `acknowledgeCritical`.
   */
  push(input: ToastInput): string;
  /** Scorciatoia per un allarme bloccante (sirena + overlay + PIN opzionale). */
  addCritical(input: Omit<ToastInput, 'priority' | 'tone'>): string;
  /** Chiude un toast non critico: sui `critical` è volutamente un no-op. */
  dismiss(id: string): void;
  /** Riconosce un allarme critico, lo sposta nello storico e ferma la sirena. */
  acknowledgeCritical(id: string): void;
  /** Interrompe solo il suono, mantenendo l'allarme visibile. */
  silenceAlarm(): void;
}

const AUTO_DISMISS_MS: Record<'info' | 'warning', number> = {
  info: 4_000,
  warning: 9_000,
};

/** Toast non critici visibili contemporaneamente. */
const MAX_VISIBLE = 4;
/** Allarmi tacitati conservati per la diagnostica. */
const MAX_HISTORY = 20;

function priorityOf(input: ToastInput): ToastPriority {
  if (input.priority) return input.priority;
  // Le chiamate storiche passano solo `tone`: un errore è un'anomalia da
  // leggere (warning), tutto il resto è feedback (info).
  return input.tone === 'error' ? 'warning' : 'info';
}

/**
 * Limitare la coda non deve mai scartare un allarme: i critici restano tutti,
 * i transitori si fermano agli ultimi `MAX_VISIBLE`.
 */
function trimVisible(toasts: ToastMessage[]): ToastMessage[] {
  const criticals = toasts.filter((toast) => toast.priority === 'critical');
  const others = toasts.filter((toast) => toast.priority !== 'critical').slice(-MAX_VISIBLE);
  return [...others, ...criticals];
}

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  history: [],
  alarmSilenced: false,

  push(input) {
    const priority = priorityOf(input);
    const message: ToastMessage = {
      id: randomId(),
      title: input.title,
      priority,
      timestamp: input.timestamp ?? Date.now(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.requirePin !== undefined ? { requirePin: input.requirePin } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };

    set((state) => ({
      toasts: trimVisible([...state.toasts, message]),
      // Un nuovo allarme riattiva la sirena anche se era stata tacitata.
      alarmSilenced: priority === 'critical' ? false : state.alarmSilenced,
    }));

    if (priority !== 'critical') {
      const timeout = input.durationMs ?? AUTO_DISMISS_MS[priority];
      window.setTimeout(() => get().dismiss(message.id), timeout);
    }

    return message.id;
  },

  addCritical(input) {
    return get().push({ ...input, priority: 'critical' });
  },

  dismiss(id) {
    set((state) => ({
      // Un allarme non può essere chiuso senza riconoscimento esplicito.
      toasts: state.toasts.filter((toast) => toast.id !== id || toast.priority === 'critical'),
    }));
  },

  acknowledgeCritical(id) {
    const target = get().toasts.find((toast) => toast.id === id);
    if (!target || target.priority !== 'critical') return;

    const acknowledged: ToastMessage = { ...target, acknowledgedAt: Date.now() };
    set((state) => {
      const remaining = state.toasts.filter((toast) => toast.id !== id);
      return {
        toasts: remaining,
        history: [acknowledged, ...state.history].slice(0, MAX_HISTORY),
        // Con l'ultimo allarme chiuso la sirena si riarma per il prossimo.
        alarmSilenced: remaining.some((toast) => toast.priority === 'critical')
          ? state.alarmSilenced
          : false,
      };
    });
  },

  silenceAlarm() {
    set({ alarmSilenced: true });
  },
}));

/** Conteggio dei critici attivi: selettore primitivo, nessun re-render extra. */
export function selectCriticalCount(state: ToastState): number {
  return state.toasts.reduce(
    (count, toast) => (toast.priority === 'critical' ? count + 1 : count),
    0,
  );
}
