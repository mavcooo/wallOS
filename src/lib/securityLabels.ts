/**
 * Etichette e icone condivise fra overlay di allarme e storico.
 *
 * I tipi di evento arrivano dal worker (`smoke`, `motion`, `contact`, …): la UI
 * deve raggrupparli in poche categorie leggibili a distanza, senza duplicare la
 * mappa in ogni componente.
 */

export type SecurityAlarmKind = 'smoke' | 'flood' | 'gas' | 'co' | 'intrusion' | 'generic';

/** Categoria visiva di un `security_events.event_type`. */
export function securityAlarmKind(eventType: string): SecurityAlarmKind {
  switch (eventType) {
    case 'smoke':
    case 'flood':
    case 'gas':
    case 'co':
      return eventType;
    case 'motion':
    case 'contact':
    case 'tamper':
    case 'intrusion':
      return 'intrusion';
    default:
      return 'generic';
  }
}

/** Stato dell'evento mostrato nello storico (calcolato dai timbri). */
export type SecurityLifecycle = 'open' | 'acknowledged' | 'resolved';

export function securityLifecycle(event: {
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}): SecurityLifecycle {
  if (event.resolvedAt !== null) return 'resolved';
  if (event.acknowledgedAt !== null) return 'acknowledged';
  return 'open';
}
