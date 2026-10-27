import { create } from 'zustand';

import type { HeapMemorySample } from '@/lib/deviceHealth';

/** Stato della batteria riportato dal browser (`Battery Status API`). */
export interface DeviceHealthBattery {
  /** `false` su Safari/iPadOS e Firefox: la card lo dichiara, non inventa numeri. */
  supported: boolean;
  /** 0-100. */
  level: number;
  charging: boolean;
  /** Secondi stimati dall'API, 0 quando sconosciuti. */
  chargingTimeSec: number;
}

/** Campione diagnostico del browser (heap, frame rate, istante di misura). */
export interface DeviceHealthSample {
  heap: HeapMemorySample | null;
  /** Quota di heap in uso (0-1), `null` dove `performance.memory` non esiste. */
  heapRatio: number | null;
  /** Frame rate medio dell'ultima finestra di misura, `null` se non misurato. */
  fps: number | null;
  sampledAt: number | null;
}

export interface DeviceHealthSnapshot extends DeviceHealthBattery, DeviceHealthSample {}

interface DeviceHealthState extends DeviceHealthSnapshot {
  setBattery(battery: DeviceHealthBattery): void;
  setSample(sample: DeviceHealthSample): void;
}

/**
 * Ultima fotografia di salute del pannello.
 *
 * Vive fuori dai componenti perché la produce il monitor montato una volta a
 * livello root (`useDeviceHealth`) e la leggono la card in Impostazioni e
 * chiunque altro serva, senza avviare un secondo campionamento.
 */
export const useDeviceHealthStore = create<DeviceHealthState>()((set) => ({
  supported: false,
  level: 0,
  charging: false,
  chargingTimeSec: 0,
  heap: null,
  heapRatio: null,
  fps: null,
  sampledAt: null,

  setBattery(battery) {
    set(battery);
  },

  setSample(sample) {
    set(sample);
  },
}));
