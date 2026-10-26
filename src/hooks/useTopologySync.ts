import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import i18n from '@/i18n';
import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import { useMqttApi } from '@/mqtt/MqttProvider';
import {
  onTopologyChanged,
  parseTopologyChanged,
  type TopologyChangedEvent,
} from '@/mqtt/topologyEvents';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type { ConnectionStatus } from '@/types/mqtt';

/**
 * Finestra di accorpamento degli eventi: una raffica di modifiche (riordino
 * multiplo, configurazione iniziale in bulk) produce **un solo** refetch, così
 * il pool PostgreSQL non vede decine di `GET /api/topology` concorrenti.
 * Il valore attivo è in `homeStore.topologySync.debounceMs`, configurabile da
 * Impostazioni (default `TOPOLOGY_SYNC_DEFAULTS.debounceMs`).
 */

const API_BASE = (import.meta.env.VITE_AUTH_API_BASE?.trim() || '/api').replace(/\/+$/, '');

/**
 * Sincronizzazione topologia multi-client.
 *
 * Canale primario: evento MQTT `wallos/system/topology_changed` pubblicato dal
 * server dopo ogni commit su PostgreSQL. Canale di ripiego: stream SSE su
 * `GET /api/topology/events`, aperto **solo** quando la socket MQTT non è viva
 * (broker in manutenzione o demo mode) e chiuso appena MQTT ritorna.
 *
 * Sulla chiusura:
 * - ogni evento (da entrambi i canali) → invalidazione `['topology']` con
 *   debounce 300 ms + toast. La chiave è una sola: stanze, dispositivi e
 *   scenari vivono sotto `['topology']` (`select` nei vari hook), quindi non
 *   esistono `['rooms']`/`['devices']` separati da invalidare;
 * - riconnessione MQTT o riapertura dello stream SSE → refetch di sicurezza
 *   senza toast, per allineare il client con PostgreSQL dopo un blackout.
 *
 * Da montare dentro `<MqttProvider>` (usa `useMqttApi` per riallineare le
 * sottoscrizioni ai topic dei device appena creati).
 */
export function useTopologySync(): void {
  const queryClient = useQueryClient();
  const { refreshSubscriptions } = useMqttApi();

  const timerRef = useRef<number | null>(null);
  /** true se almeno un evento della finestra corrente chiede il toast. */
  const toastRef = useRef(false);
  /** Il server SSE è già stato aperto almeno una volta in questa sessione. */
  const sseHasOpenedRef = useRef(false);
  const clientId = useHomeStore((state) => state.broker.clientId);
  const clientIdRef = useRef(clientId);
  const debounceMs = useHomeStore((state) => state.topologySync.debounceMs);
  // Ref invece delle dipendenze: cambiare il valore da Impostazioni non deve
  // ricreare gli effetti (riaprirebbe lo stream SSE per un refetch inutile).
  const debounceRef = useRef(debounceMs);

  useEffect(() => {
    clientIdRef.current = clientId;
  }, [clientId]);

  useEffect(() => {
    debounceRef.current = debounceMs;
  }, [debounceMs]);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const withToast = toastRef.current;
    toastRef.current = false;

    // invalidateQueries attende il refetch: solo allora i nuovi `state_topic`
    // compaiono nell'indice e vale la pena riallineare le sottoscrizioni.
    void queryClient
      .invalidateQueries({ queryKey: TOPOLOGY_QUERY_KEY })
      .finally(() => refreshSubscriptions());

    if (withToast) {
      // `i18n.t` diretto (come in `useMqtt`): il callback non cambia identità
      // al cambio di lingua e lo stream SSE non si riapre per un refetch inutile.
      useToastStore.getState().push({
        title: i18n.t('topologySync.toastTitle'),
        description: i18n.t('topologySync.toastDescription'),
        tone: 'info',
      });
    }
  }, [queryClient, refreshSubscriptions]);

  const schedule = useCallback(
    (withToast: boolean) => {
      if (withToast) toastRef.current = true;
      // Timer già in corsa: la scadenza resta la prima, la finestra accorpa.
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(flush, debounceRef.current);
    },
    [flush],
  );

  /** Evento valido da qualunque canale: scarta la propria mutazione locale. */
  const handleEvent = useCallback(
    (event: TopologyChangedEvent | null) => {
      if (!event) return;
      if (event.sourceClientId && event.sourceClientId === clientIdRef.current) return;
      schedule(true);
    },
    [schedule],
  );

  // 1. Canale primario: eventi MQTT già instradati da `useMqtt`.
  useEffect(() => onTopologyChanged((event) => handleEvent(event)), [handleEvent]);

  // 2. Canale di ripiego: SSE finché il broker non è raggiungibile. Il browser
  //    riconnette da solo (`retry: 3000`): ogni riapertura riallinea il client.
  const status = useHomeStore((state) => state.connection.status);
  const demoMode = useHomeStore((state) => state.broker.demoMode);
  const sseEnabled = demoMode || status !== 'connected';

  useEffect(() => {
    if (!sseEnabled || typeof EventSource === 'undefined') return;

    const source = new EventSource(`${API_BASE}/topology/events`, { withCredentials: true });
    source.onopen = () => {
      // La prima apertura coincide con l'avvio (la topologia è appena arrivata
      // dalla gate): il refetch di sicurezza serve solo alle riaperture, quando
      // il canale precedente è potuto restare muto.
      if (sseHasOpenedRef.current) schedule(false);
      sseHasOpenedRef.current = true;
    };
    source.onmessage = (event) => handleEvent(parseTopologyChanged(event.data));
    // `onerror`: niente handler, il browser riprova da solo con `retry: 3000`.

    return () => source.close();
  }, [sseEnabled, handleEvent, schedule]);

  // 3. Refetch di sicurezza al rientro MQTT. Al primo `connected` non refetch:
  //    la topologia è appena arrivata dalla gate.
  useEffect(() => {
    let previous: ConnectionStatus = useHomeStore.getState().connection.status;
    let seenConnected = previous === 'connected';
    return useHomeStore.subscribe((state) => {
      const status = state.connection.status;
      if (status === previous) return;
      const reconnected = status === 'connected' && previous !== 'connected' && seenConnected;
      previous = status;
      if (status === 'connected') seenConnected = true;
      if (reconnected) schedule(false);
    });
  }, [schedule]);

  // Un evento ancora in coda allo smontaggio non deve invalidare dopo il logout.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      toastRef.current = false;
    },
    [],
  );
}
