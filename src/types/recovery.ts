/**
 * Stato del Safe Boot: dopo un riavvio (blackout, refresh, crash del browser)
 * il pannello non conosce lo stato reale dei relè finché il broker non ha
 * consegnato i messaggi retained.
 */
export interface RecoveryState {
  /** Epoch ms del boot del client: base per scartare i comandi pre-blackout. */
  bootedAt: number;
  /** true finché la casa non è dichiarata sincronizzata: blocca UI e coda. */
  isHydrating: boolean;
  /** Retained ricevuti da questo avvio: progresso della sincronizzazione. */
  retainedMessagesReceived: number;
  /** Epoch ms dell'ultimo retained (base del debounce di quiete). */
  lastRetainedAt: number | null;
  /**
   * L'ultima finestra si è chiusa senza aver mai visto il broker (pannello
   * rimasto offline oltre il tetto): al primo CONNACK l'idratazione riparte,
   * altrimenti i comandi uscirebbero prima dei retained.
   */
  awaitingFirstConnect: boolean;
}

/** Perché la finestra di idratazione si è chiusa (log diagnostico). */
export type HydrationEndReason = 'quiet' | 'timeout';
