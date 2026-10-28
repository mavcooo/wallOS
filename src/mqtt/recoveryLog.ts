import { randomId } from '@/lib/randomId';
import { useHomeStore } from '@/store/homeStore';

/**
 * Diagnostica del Safe Boot nel buffer RAW del pannello (Impostazioni → Test
 * topic) e in console: dopo un blackout serve capire *cosa* è stato scartato,
 * senza dipendere dal fatto che il browser sia collegato a un devtools.
 */
export function logRecovery(message: string): void {
  useHomeStore.getState().appendRaw({
    id: randomId(),
    direction: 'system',
    topic: 'recovery',
    payload: message,
    qos: 0,
    retain: false,
    at: Date.now(),
  });
  console.info(`[Recovery] ${message}`);
}
