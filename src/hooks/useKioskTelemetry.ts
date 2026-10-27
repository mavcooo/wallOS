import { useCallback, useEffect, useMemo, useRef } from 'react';

import { BATTERY_GUARDIAN } from '@/config/app.config';
import { useMqttApi } from '@/mqtt/MqttProvider';
import {
  BATTERY_TELEMETRY_PUBLISH,
  batteryTelemetryPayload,
  batteryTelemetrySignature,
  kioskBatteryTopic,
  serializeBatteryTelemetry,
} from '@/services/kioskTelemetry';
import { useHomeStore } from '@/store/homeStore';
import { getKioskId } from '@/utils/kioskIdentity';
import { useBatteryStatus } from './useBatteryStatus';

/**
 * Battery Guardian: pubblica la carica del pannello sul broker.
 *
 * Topic `wallos/kiosk/<kiosk_id>/battery` (sotto il base topic della casa),
 * payload `{ kioskId, level, charging, timestamp }`, QoS 1 e `retain: true`:
 * una presa smart collegata all'alimentatore legge l'ultimo valore retained e
 * stacca la carica all'80%, riattaccandola al 20%. La fascia 20-80% è ciò che
 * evita il gonfiarsi delle celle su un tablet alimentato H24.
 *
 * Pubblica:
 * - all'avvio e a ogni cambio di livello o di stato di carica (l'evento è la
 *   via più rapida: è così che la soglia dell'80% arriva subito alla presa);
 * - ogni `publishIntervalMs` (60 s): con la scheda in background il browser può
 *   non consegnare gli eventi, e il retained deve restare fresco;
 * - alla riconnessione del broker, se lo stato è cambiato nel frattempo.
 *
 * Dove la Battery Status API non esiste (iPadOS/Safari) **non pubblica nulla**:
 * meglio nessun dato che un livello inventato che farebbe staccare la presa.
 */

export interface UseKioskTelemetryOptions {
  /** Periodo della pubblicazione di refresh (default 60 s). */
  publishIntervalMs?: number;
}

export function useKioskTelemetry(options: UseKioskTelemetryOptions = {}): void {
  const { publishRaw } = useMqttApi();
  const battery = useBatteryStatus();
  const kioskId = useMemo(getKioskId, []);
  const publishIntervalMs = options.publishIntervalMs ?? BATTERY_GUARDIAN.publishIntervalMs;
  const connectionStatus = useHomeStore((state) => state.connection.status);

  // Lo stato più recente senza riavviare timer a ogni evento.
  const batteryRef = useRef(battery);
  const sentSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    batteryRef.current = battery;
  }, [battery]);

  const publish = useCallback(
    (mode: 'change' | 'periodic') => {
      const current = batteryRef.current;
      if (!current.isSupported) return;

      // Montaggio + primo CONNACK pubblicherebbero lo stesso campione due
      // volte: si ripete solo se qualcosa è davvero cambiato (o al tick).
      const signature = batteryTelemetrySignature(current);
      if (mode === 'change' && signature === sentSignatureRef.current) return;
      sentSignatureRef.current = signature;

      publishRaw(
        kioskBatteryTopic(kioskId),
        serializeBatteryTelemetry(batteryTelemetryPayload(kioskId, current)),
        BATTERY_TELEMETRY_PUBLISH,
      );
    },
    [kioskId, publishRaw],
  );

  useEffect(() => {
    publish('change');
  }, [publish, battery.isSupported, battery.level, battery.charging]);

  useEffect(() => {
    const timer = window.setInterval(() => publish('periodic'), publishIntervalMs);
    return () => window.clearInterval(timer);
  }, [publish, publishIntervalMs]);

  // Blackout risolto: il retained del broker può essere vecchio di ore.
  useEffect(() => {
    if (connectionStatus === 'connected') publish('change');
  }, [connectionStatus, publish]);
}
