import { useEffect } from 'react';

import { BATTERY_GUARDIAN } from '@/config/app.config';
import i18n from '@/i18n';
import { heapUsageRatio, readHeapMemory, sampleFrameRate } from '@/lib/deviceHealth';
import { formatBytes } from '@/lib/utils';
import { useDeviceHealthStore, type DeviceHealthSnapshot } from '@/store/deviceHealthStore';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import { useBatteryStatus } from './useBatteryStatus';

/**
 * Watchdog diagnostico del pannello.
 *
 * Un tablet a parete non si riavvia mai: il browser resta in esecuzione per
 * settimane e l'unico segnale che qualcosa sta degradando è la memoria heap
 * (che su Chromium è più affidabile del frame rate, che oscilla con le
 * animazioni in corso). Qui si campionano heap e frame rate, si tiene traccia
 * della latenza MQTT e, oltre la soglia, si emette un avviso **strutturato**
 * (console per il log remoto, toast per chi passa davanti al pannello).
 *
 * Il campionamento è periodico e breve: un contatore rAF perpetuo sarebbe
 * esattamente il lavoro che si vuole misurare.
 */

export interface UseDeviceHealthOptions {
  /** Intervallo fra due campionamenti (default 30 s). */
  sampleIntervalMs?: number;
  /** Durata della finestra di misura del frame rate (default 1 s). */
  fpsWindowMs?: number;
}

/**
 * Fotografia condivisa: la produce il monitor montato a livello root, la legge
 * la card in Impostazioni. Nessun secondo campionamento, nessun rAF doppio.
 */
export function useDeviceHealthSnapshot(): DeviceHealthSnapshot {
  return useDeviceHealthStore((state) => state);
}

export function useDeviceHealth(options: UseDeviceHealthOptions = {}): void {
  const battery = useBatteryStatus();
  const sampleIntervalMs = options.sampleIntervalMs ?? BATTERY_GUARDIAN.sampleIntervalMs;
  const fpsWindowMs = options.fpsWindowMs ?? BATTERY_GUARDIAN.fpsWindowMs;

  // La batteria arriva dagli eventi del browser: lo store resta allineato a
  // ogni `levelchange`/`chargingchange`, senza polling.
  useEffect(() => {
    useDeviceHealthStore.getState().setBattery({
      supported: battery.isSupported,
      level: battery.level,
      charging: battery.charging,
      chargingTimeSec: battery.chargingTime,
    });
  }, [battery.isSupported, battery.level, battery.charging, battery.chargingTime]);

  useEffect(() => {
    let active = true;
    let heapWarnedAt = 0;
    let fpsWarnedAt = 0;

    const sample = async () => {
      const heap = readHeapMemory();
      const heapRatio = heapUsageRatio(heap);
      const fps = await sampleFrameRate(fpsWindowMs);
      if (!active) return;

      useDeviceHealthStore.getState().setSample({
        heap,
        heapRatio,
        fps: fps > 0 ? fps : null,
        sampledAt: Date.now(),
      });
      const latencyMs = useHomeStore.getState().connection.latencyMs;

      // Heap oltre l'85%: è la soglia oltre cui Chromium inizia a rallentare e
      // il pannello rischia un freeze silenzioso. Un solo toast per finestra.
      if (
        heapRatio !== null &&
        heapRatio > BATTERY_GUARDIAN.heapWarnRatio &&
        Date.now() - heapWarnedAt >= BATTERY_GUARDIAN.heapAlertCooldownMs
      ) {
        heapWarnedAt = Date.now();
        console.warn('[health] heap JavaScript oltre la soglia', {
          heapRatio: Number(heapRatio.toFixed(3)),
          usedBytes: heap?.usedBytes ?? null,
          limitBytes: heap?.limitBytes ?? null,
          fps,
          latencyMs,
        });
        useToastStore.getState().push({
          title: i18n.t('health.heapWarnTitle'),
          description: i18n.t('health.heapWarnDescription', {
            percent: Math.round(heapRatio * 100),
            used: formatBytes(heap?.usedBytes ?? 0),
            limit: formatBytes(heap?.limitBytes ?? 0),
          }),
          priority: 'warning',
        });
      }

      // Frame rate basso: dato diagnostico, resta nel log (nessun toast: il
      // pannello può essere semplicemente fermo su una schermata statica).
      if (
        fps > 0 &&
        fps < BATTERY_GUARDIAN.minHealthyFps &&
        Date.now() - fpsWarnedAt >= BATTERY_GUARDIAN.fpsLogCooldownMs
      ) {
        fpsWarnedAt = Date.now();
        console.warn('[health] frame rate sotto la soglia di fluidità', {
          fps,
          minHealthyFps: BATTERY_GUARDIAN.minHealthyFps,
          heapRatio,
          latencyMs,
        });
      }
    };

    void sample();
    const timer = window.setInterval(() => void sample(), sampleIntervalMs);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [fpsWindowMs, sampleIntervalMs]);
}
