import { useDatabaseHealthMonitor } from '@/hooks/useDatabaseHealth';

/**
 * Unico punto in cui gira il polling del database: aggiorna lo store letto
 * dall'header e delega le notifiche al Toaster globale applicazione.
 */
export function DatabaseHealthMonitor() {
  useDatabaseHealthMonitor();
  return null;
}
