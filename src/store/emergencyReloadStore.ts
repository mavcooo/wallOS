import { create } from 'zustand';

/**
 * Stato UI del watchdog di rete, non persistito.
 *
 * Separato da `homeStore` perché cambia una volta al secondo durante il
 * countdown: tenerlo qui evita che ogni tick ridisegni header, badge e card.
 * Il watchdog scrive (fase/countdown), la modal legge e chiama le azioni.
 */
export interface EmergencyReloadState {
  /** true quando il socket MQTT è dichiarato congelato (badge ambra). */
  frozen: boolean;
  /** Epoch ms da cui dura il blackout (null = nessun blackout attivo). */
  blackoutSince: number | null;
  /** Epoch ms in cui scatterebbe il reload (null = nessun countdown). */
  reloadAt: number | null;
  /** Secondi rimanenti al reload (aggiornati ogni secondo). */
  remainingSeconds: number | null;
  /** L'utente ha annullato il riavvio: il countdown non ricompare da solo. */
  cancelled: boolean;
  /** Callback registrato dal watchdog per il retry manuale ("Riprova Ora"). */
  retryHandler: (() => void) | null;
  /** Callback registrato dal watchdog per annullare il countdown di reload. */
  cancelHandler: (() => void) | null;

  setFrozen(frozen: boolean, at: number | null): void;
  startCountdown(since: number, reloadAt: number): void;
  setRemaining(seconds: number): void;
  cancelReload(): void;
  registerRetryHandler(handler: (() => void) | null): void;
  registerCancelHandler(handler: (() => void) | null): void;
  /** Reset completo (ripristino della connessione o unmount). */
  reset(): void;
}

export const useEmergencyReloadStore = create<EmergencyReloadState>()((set, get) => ({
  frozen: false,
  blackoutSince: null,
  reloadAt: null,
  remainingSeconds: null,
  cancelled: false,
  retryHandler: null,
  cancelHandler: null,

  setFrozen(frozen, at) {
    set({
      frozen,
      // Il blackout inizia quando la connessione si congela; si azzera al
      // ritorno del traffico (frozen === false).
      blackoutSince: frozen ? (get().blackoutSince ?? at) : null,
      ...(frozen ? {} : { reloadAt: null, remainingSeconds: null, cancelled: false }),
    });
  },

  startCountdown(since, reloadAt) {
    set({
      blackoutSince: since,
      reloadAt,
      remainingSeconds: Math.max(0, Math.round((reloadAt - Date.now()) / 1_000)),
      cancelled: false,
    });
  },

  setRemaining(seconds) {
    set({ remainingSeconds: Math.max(0, seconds) });
  },

  cancelReload() {
    // L'annullo vale anche per il watchdog: senza questo ponte il countdown
    // ricomincerebbe al tick successivo e la riaprirebbe la modal.
    get().cancelHandler?.();
    set({ cancelled: true, reloadAt: null, remainingSeconds: null });
  },

  registerRetryHandler(handler) {
    set({ retryHandler: handler });
  },

  registerCancelHandler(handler) {
    set({ cancelHandler: handler });
  },

  reset() {
    set({
      frozen: false,
      blackoutSince: null,
      reloadAt: null,
      remainingSeconds: null,
      cancelled: false,
      retryHandler: null,
      cancelHandler: null,
    });
  },
}));

/** Selettore booleano per AppShell (dimmer hold): nessun re-render per il resto. */
export function selectReloadPending(state: EmergencyReloadState): boolean {
  return state.reloadAt !== null && !state.cancelled;
}
