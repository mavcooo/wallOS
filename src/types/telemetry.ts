import type { DecodedState } from '@/types/device';

/**
 * Configurazione runtime del buffer telemetria.
 * Persistita nello store, così il throttle resta tarabile senza rebuild.
 */
export interface TelemetrySettings {
  /** Finestra massima di accumulo prima del flush (500–2000 ms, default 1000). */
  throttleMs: number;
  /** Variazione relativa (0.02 = 2%) oltre la quale un campione è "significativo". */
  significantDeltaRatio: number;
}

/** Aggiornamento telemetria già aggregato, pronto per lo store. */
export interface TelemetryUpdate {
  deviceId: string;
  decoded: DecodedState;
  /** Timestamp di arrivo del campione più recente (non del flush). */
  at: number;
}

/** Voce interna del buffer, con ordine monotono per scartare flush fuori sequenza. */
export interface BufferedTelemetry extends TelemetryUpdate {
  seq: number;
}

export interface TelemetryBufferStats {
  /** Campioni telemetria entrati nel buffer. */
  received: number;
  /** Campioni assorbiti da un'aggiornamento precedente dello stesso device. */
  coalesced: number;
  /** Aggiornamenti applicati allo store (un flush può contenerne più d'uno). */
  flushes: number;
  /** Aggiornamenti critici che hanno bypassato il buffer. */
  criticalBypass: number;
  /** Device attualmente in attesa di flush. */
  buffered: number;
}

export type TelemetryUpdateKind = 'critical' | 'telemetry' | 'ignored';
