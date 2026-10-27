import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { applyContrastAttribute } from '@/lib/contrast';
import { kioskApi } from '@/lib/kioskApi';
import { applyKioskOrientation, setKioskPinRequired } from '@/lib/kioskPolicy';
import { applyPerformanceMode } from '@/lib/performance';
import { useHomeStore } from '@/store/homeStore';
import { useContrastStore } from '@/store/contrastStore';
import type { KioskDisplay, KioskDisplayPatch } from '@/types/kiosk';

/** Configurazione del display corrente. */
export const kioskQueryKey = (id: string) => ['kiosk', id] as const;

/** Elenco per la scheda Display dell'amministrazione. */
export const kioskListQueryKey = ['kiosk', 'list'] as const;

/**
 * Applica la configurazione del server agli store del pannello.
 *
 * È idempotente: la chiamano sia il bootstrap (prima del primo render utile)
 * sia `useKioskSync` (modifica dell'amministratore a pannello acceso).
 *
 * L'alto contrasto passa dallo store: il hook root `useHighContrast` scrive
 * `data-contrast` sul documento, quindi qui non si tocca l'attributo a mano.
 */
export function applyKioskConfig(display: KioskDisplay): void {
  const store = useHomeStore.getState();
  store.setDimmerTimeout(Math.round(display.dimmerTimeoutSec) * 1000);

  // `setEnabled` non esiste fuori da React: attributo e store insieme,
  // altrimenti il prossimo render di `usePerformanceMode` riallineerebbe
  // l'attributo al valore vecchio.
  applyPerformanceMode(display.performanceMode);
  store.setPerformanceMode(display.performanceMode);

  useContrastStore.getState().setPreference(display.highContrast ? 'on' : 'off');
  applyContrastAttribute(display.highContrast);

  setKioskPinRequired(display.pinRequired);
  applyKioskOrientation(display.screenOrientation);
}

/**
 * Configurazione del display: `GET /api/kiosk/:id` auto-registra il pannello al
 * primo avvio, quindi qui non esiste il caso "404 al boot".
 */
export function useKioskQuery(id: string) {
  return useQuery({
    queryKey: kioskQueryKey(id),
    queryFn: () => kioskApi.get(id).then((payload) => payload.display),
    staleTime: 5 * 60_000,
  });
}

/** Griglia admin: l'elenco invecchia in 30 s (presenza online/offline). */
export function useKioskDisplays() {
  return useQuery({
    queryKey: kioskListQueryKey,
    queryFn: () => kioskApi.list().then((payload) => payload.displays),
    refetchInterval: 30_000,
  });
}

/**
 * Salvataggio: aggiorna la cache del display toccato e invalida l'elenco.
 * La notifica MQTT la pubblica il server dentro la stessa richiesta, così il
 * pannello la riceve anche se questa scheda viene chiusa subito dopo.
 */
export function useUpdateKiosk(): UseMutationResult<
  { display: KioskDisplay },
  Error,
  { id: string; patch: KioskDisplayPatch }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, patch }) => kioskApi.update(id, patch),
    onSuccess: (payload, { id }) => {
      queryClient.setQueryData(kioskQueryKey(id), payload.display);
      void queryClient.invalidateQueries({ queryKey: kioskListQueryKey });
    },
  });
}
