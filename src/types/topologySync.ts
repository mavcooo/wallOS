/** Preferenze di sincronizzazione topologia multi-client. */
export interface TopologySyncSettings {
  /**
   * Finestra (ms) in cui gli eventi ricevuti vengono accorpati in un unico
   * refetch. 0 = refetch immediato a ogni evento (resta il batch del tick).
   */
  debounceMs: number;
}
