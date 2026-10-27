import { useEffect, useMemo } from 'react';

import { useHomeStore } from '@/store/homeStore';
import { getKioskId } from '@/utils/kioskIdentity';
import { applyKioskConfig, useKioskQuery } from './useKioskProfile';

/**
 * Sessione corrente: ultima `updated_at` applicata al pannello. Un refetch che
 * riporta la stessa configurazione non deve sovrascrivere una preferenza
 * cambiata a mano sul tablet; una modifica del server (timestamp più nuovo) sì.
 */
let appliedUpdatedAt = 0;

/** Display già riportato alla stanza iniziale in questa sessione. */
let navigatedId: string | null = null;

/**
 * Idratazione del pannello all'avvio.
 *
 * Legge `GET /api/kiosk/:kiosk_id` (che al primo boot **auto-registra** il
 * display: nessun 404, nessun passaggio manuale) e trasferisce i valori negli
 * store: timeout del dimmer, alto contrasto, performance mode, PIN dei device
 * protetti, orientamento. Se il display ha una stanza iniziale configurata,
 * l'app parte lì invece che sulla generica Overview.
 *
 * Resta volutamente senza UI: finché la risposta non arriva valgono i valori
 * del persist locale, quindi il pannello non mostra un caricamento.
 */
export function useKioskBootstrap(): void {
  // `useMemo`: l'id è stabile per tutta la vita della scheda (cookie decennale).
  const id = useMemo(getKioskId, []);
  const { data } = useKioskQuery(id);

  useEffect(() => {
    if (!data) return;
    if (data.updatedAt > appliedUpdatedAt) {
      appliedUpdatedAt = data.updatedAt;
      applyKioskConfig(data);
    }

    if (navigatedId === id) return;
    navigatedId = id;
    if (!data.defaultRoomId) return;
    const store = useHomeStore.getState();
    store.setRoom(data.defaultRoomId);
    store.setView('rooms');
  }, [data, id]);
}

/** Solo per i test: dimentica gli id già applicati. */
export function resetKioskBootstrap(): void {
  appliedUpdatedAt = 0;
  navigatedId = null;
}
