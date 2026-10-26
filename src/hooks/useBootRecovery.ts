import { useEffect } from 'react';

import { BOOT_RECOVERY } from '@/config/app.config';
import { flushOfflineQueue, purgeStaleCommandsOnBoot } from '@/mqtt/offlineQueue';
import { logRecovery } from '@/mqtt/recoveryLog';
import { useHomeStore } from '@/store/homeStore';
import type { HydrationEndReason } from '@/types/recovery';

function finish(reason: HydrationEndReason): void {
  const { recovery, finishHydration, connection } = useHomeStore.getState();
  if (!recovery.isHydrating) return;
  const sawBroker = connection.connectedAt !== null;
  finishHydration(sawBroker);

  const elapsed = sawBroker
    ? `${((Date.now() - (connection.connectedAt ?? 0)) / 1_000).toFixed(1)}s dal connect`
    : 'broker mai connesso, si riarma al primo CONNACK';
  logRecovery(
    `Idratazione completata (${reason}): ${recovery.retainedMessagesReceived} retained, ${elapsed}`,
  );
}

/**
 * Safe Boot & Power Failure Recovery.
 *
 * Dopo un blackout il pannello e i relè ripartono insieme: per alcuni secondi
 * la dashboard non conosce lo stato reale delle luci e dei carichi. Questo hook
 * gestisce l'intera finestra:
 *
 * 1. **coda offline** → i comandi ripresi dallo storage e nati prima di questo
 *    avvio vengono scartati *prima* di qualsiasi connessione (`purgeStaleCommandsOnBoot`);
 * 2. **tetto** → `maxHydrationMs` dall'avvio: la UI si sblocca anche se il broker
 *    è muto o assente (mai un pannello congelato);
 * 3. **quiete** → l'idratazione finisce quando il broker smette di consegnare
 *    retained per `quietWindowMs`, ma non prima di `minHydrationMs` dal connect;
 * 4. **rilascio** → a fine idratazione la coda offline torna operativa per le
 *    normali cadute di Wi-Fi.
 *
 * `isHydrating` vive in `homeStore.recovery`: la UI lo legge per bloccare i
 * comandi e la coda lo legge per restare in pausa.
 *
 * Da montare a livello root (una sola volta per avvio dell'app).
 */
export function useBootRecovery(): void {
  const isHydrating = useHomeStore((state) => state.recovery.isHydrating);
  const retained = useHomeStore((state) => state.recovery.retainedMessagesReceived);
  const status = useHomeStore((state) => state.connection.status);

  // 1. Pulizia one-shot, prima che una socket o un flush possano partire.
  useEffect(() => {
    const { bootedAt } = useHomeStore.getState().recovery;
    purgeStaleCommandsOnBoot({ bootedAt });
  }, []);

  // 2. Tetto massimo: nessun pannello deve restare bloccato su un broker muto.
  useEffect(() => {
    if (!isHydrating) return;
    const timer = window.setTimeout(() => finish('timeout'), BOOT_RECOVERY.maxHydrationMs);
    return () => window.clearTimeout(timer);
  }, [isHydrating]);

  // 3. Debounce di quiete: ogni retained sposta la scadenza, il pavimento evita
  //    un flash "sincronizzato" su un broker che non ha ancora risposto.
  useEffect(() => {
    if (!isHydrating) return;
    const state = useHomeStore.getState();
    if (state.connection.status !== 'connected') return;

    const connectedAt = state.connection.connectedAt ?? Date.now();
    const earliest = connectedAt + BOOT_RECOVERY.minHydrationMs;
    const quietAt = Math.max(
      earliest,
      (state.recovery.lastRetainedAt ?? connectedAt) + BOOT_RECOVERY.quietWindowMs,
    );

    const timer = window.setTimeout(() => finish('quiet'), Math.max(0, quietAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [isHydrating, status, retained]);

  // 4. Idratazione conclusa: la coda in pausa riprende (vuota, dopo il purge,
  //    ma la stessa barriera vale per comandi accodati durante la finestra).
  useEffect(() => {
    if (isHydrating) return;
    void flushOfflineQueue();
  }, [isHydrating]);

  // 5. Tetto scaduto senza aver mai visto il broker (pannello rimasto offline o
  //    fermo sul lock screen): al primo CONNACK la finestra riparte, altrimenti
  //    il primo tap uscirebbe prima dei retained appena arrivati.
  useEffect(() => {
    if (isHydrating || status !== 'connected') return;
    if (!useHomeStore.getState().recovery.awaitingFirstConnect) return;
    useHomeStore.getState().startHydration();
  }, [isHydrating, status]);
}
