import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import i18n from '@/i18n';
import { onKioskConfig } from '@/mqtt/kioskEvents';
import { useToastStore } from '@/store/toastStore';
import { getKioskId } from '@/utils/kioskIdentity';
import { applyKioskConfig, kioskQueryKey } from './useKioskProfile';

/**
 * Applica a caldo le modifiche fatte dall'amministratore.
 *
 * Sottoscrizione: `wallos/system/kiosk/+/config_updated` (`useMqtt` instrada i
 * messaggi su `kioskEvents`), filtro sull'id di **questo** pannello.
 *
 * Alla ricezione: cache TanStack Query aggiornata, preferenze applicate subito
 * agli store (il timer del dimmer riparte dal nuovo valore senza reload) e un
 * toast discreto che spiega perché lo schermo ha appena cambiato aspetto.
 */
export function useKioskSync(): void {
  const id = useMemo(getKioskId, []);
  const queryClient = useQueryClient();

  useEffect(
    () =>
      onKioskConfig((event) => {
        if (event.id !== id) return;
        queryClient.setQueryData(kioskQueryKey(id), event.config);
        applyKioskConfig(event.config);
        useToastStore.getState().push({
          title: i18n.t('kioskSync.title'),
          description: i18n.t('kioskSync.description', { name: event.config.name }),
          tone: 'info',
        });
      }),
    [id, queryClient],
  );
}
