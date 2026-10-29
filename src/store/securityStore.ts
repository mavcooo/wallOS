import { create } from 'zustand';

import type { SecurityEventRecord, SecuritySnapshot } from '@/lib/securityApi';

/**
 * Vista sincrona dello stato di sicurezza per i consumatori che devono reagire
 * **subito** (overlay di allarme, wake del dimmer kiosk).
 *
 * La sorgente dei dati resta TanStack Query (`useSecuritySync` → `/api/security/state`
 * + stream SSE): questo store è solo il ponte verso componenti che non devono
 * rifare il fetch né dipendere da un toast in memoria. Se l'app viene ricaricata
 * o il tablet si riavvia, `useSecuritySync` rilegge gli eventi ancora aperti da
 * PostgreSQL e l'overlay ricompare.
 */
interface SecurityStoreState {
  /** Ultimo snapshot ricevuto dal server (`null` prima della prima risposta). */
  snapshot: SecuritySnapshot | null;
  setSnapshot(snapshot: SecuritySnapshot | null): void;
  reset(): void;
}

export const useSecurityStore = create<SecurityStoreState>()((set) => ({
  snapshot: null,
  setSnapshot(snapshot) {
    set({ snapshot });
  },
  reset() {
    set({ snapshot: null });
  },
}));

const NO_EVENTS: readonly SecurityEventRecord[] = [];

/** Eventi ancora aperti, in ordine di arrivo dal più recente. */
export function selectActiveAlarms(state: SecurityStoreState): readonly SecurityEventRecord[] {
  return state.snapshot?.activeEvents ?? NO_EVENTS;
}

/** Conteggio primitivo: usato dal dimmer per bloccare lo standby. */
export function selectActiveAlarmCount(state: SecurityStoreState): number {
  return state.snapshot?.activeEvents.length ?? 0;
}

/** Evento in primo piano: il più recente ancora aperto. */
export function selectPrimaryAlarm(state: SecurityStoreState): SecurityEventRecord | null {
  return state.snapshot?.activeEvents[0] ?? null;
}
