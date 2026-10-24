import { normalizeTelemetrySettings } from '@/lib/telemetry';
import {
  isNoOp,
  isSignificantChange,
  mergeDecodedState,
  splitDecoded,
} from '@/mqtt/telemetryPolicy';
import type { DecodedState, Device } from '@/types/device';
import type {
  BufferedTelemetry,
  TelemetryBufferStats,
  TelemetrySettings,
  TelemetryUpdate,
  TelemetryUpdateKind,
} from '@/types/telemetry';

/**
 * Distanza minima tra due flush dello stesso device. Anche una variazione
 * significativa non può trasformare un sensore rumoroso in un firehose:
 * al massimo 4 aggiornamenti/secondo, con la finestra come limite superiore.
 */
const MIN_EARLY_FLUSH_MS = 250;

export interface TelemetryBufferSinks {
  /** Percorso critico: una sola `set` Zustand, nessun buffer. */
  applyCritical(deviceId: string, decoded: DecodedState): void;
  /** Percorso telemetria: una sola `set` per tutti i device del flush. */
  applyTelemetry(updates: readonly TelemetryUpdate[]): void;
}

/**
 * Buffer single-producer tra `useMqtt` e lo store.
 *
 * - Il chiamante passa lo snapshot del device già composto (metadati Query +
 *   riga realtime): il buffer non ricostruisce il view-model né rilegge lo
 *   store per ogni patch, una sola composizione per messaggio.
 * - Un solo timer per l'intera applicazione, non uno per device.
 * - Accumula l'ultimo campione per device (coalescing O(1), nessuna crescita
 *   illimitata della coda).
 * - I campi critici sono applicati subito; la telemetria in attesa viene
 *   fusa nell'aggiornamento critico (prima i valori vecchi, poi il critico)
 *   così un payload datato non può sovrascrivere uno stato più recente.
 * - `seq` monotono + `appliedSeq` scartano qualsiasi flush fuori ordine.
 */
export class TelemetryUpdateBuffer {
  private readonly sinks: TelemetryBufferSinks;
  private settings: TelemetrySettings;
  private readonly pending = new Map<string, BufferedTelemetry>();
  private readonly appliedSeq = new Map<string, number>();
  private readonly lastFlushAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private disposed = false;
  private readonly stats = {
    received: 0,
    coalesced: 0,
    flushes: 0,
    criticalBypass: 0,
  };

  constructor(sinks: TelemetryBufferSinks, settings?: Partial<TelemetrySettings>) {
    this.sinks = sinks;
    this.settings = normalizeTelemetrySettings(settings);
  }

  /** Aggiorna la finestra/soglia senza perdere i campioni già in coda. */
  setSettings(patch: Partial<TelemetrySettings>): void {
    const next = normalizeTelemetrySettings({ ...this.settings, ...patch });
    if (
      next.throttleMs === this.settings.throttleMs &&
      next.significantDeltaRatio === this.settings.significantDeltaRatio
    ) {
      return;
    }
    this.settings = next;
    this.reschedule();
  }

  /**
   * Instrada una patch decodificata sul percorso corretto.
   * `device` è lo snapshot già usato per il decode: niente seconda composizione
   * né lookup nella mappa realtime dentro il buffer.
   */
  push(
    device: Device,
    decoded: DecodedState,
    observedAt = Date.now(),
  ): TelemetryUpdateKind {
    if (this.disposed) return 'ignored';
    if (device.kind !== decoded.kind) return 'ignored';

    const { critical, telemetry } = splitDecoded(device, decoded);
    if (critical) this.commitCritical(device.id, critical);
    if (telemetry) this.enqueue(device, telemetry, observedAt);
    return critical ? 'critical' : telemetry ? 'telemetry' : 'ignored';
  }

  /** Forza il flush di tutta la coda (es. riconnessione o smontaggio). */
  flush(): void {
    this.clearTimer();
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
    this.pending.clear();
    this.commit(entries);
  }

  /** Flush finale e stop definitivo (l'istanza non è più riutilizzabile). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flush();
  }

  getStats(): TelemetryBufferStats {
    return { ...this.stats, buffered: this.pending.size };
  }

  // ── Percorso critico ───────────────────────────────────────────────────────

  private commitCritical(deviceId: string, decoded: DecodedState): void {
    const pending = this.pending.get(deviceId);
    if (pending) {
      this.pending.delete(deviceId);
      this.appliedSeq.set(deviceId, Math.max(this.appliedSeq.get(deviceId) ?? 0, pending.seq));
      this.stats.coalesced += 1;
    }

    // Telemetria in attesa (più vecchia) + patch critica (più recente).
    const merged = pending ? mergeDecodedState(pending.decoded, decoded) : decoded;
    this.sinks.applyCritical(deviceId, merged);
    this.lastFlushAt.set(deviceId, Date.now());
    this.stats.criticalBypass += 1;
    this.reschedule();
  }

  // ── Percorso telemetria ────────────────────────────────────────────────────

  private enqueue(device: Device, decoded: DecodedState, observedAt: number): void {
    const deviceId = device.id;
    const pending = this.pending.get(deviceId);
    const merged = pending ? mergeDecodedState(pending.decoded, decoded) : decoded;

    // Il campione più recente vince: se il netto coincide con lo store,
    // anche l'eventuale voce precedente in coda è diventata obsoleta.
    if (isNoOp(device, merged)) {
      if (pending) {
        this.pending.delete(deviceId);
        this.reschedule();
      }
      return;
    }

    this.seq += 1;
    this.pending.set(deviceId, {
      deviceId,
      decoded: merged,
      at: observedAt,
      seq: this.seq,
    });
    this.stats.received += 1;
    if (pending) this.stats.coalesced += 1;

    // Variazione oltre soglia: flush anticipato del solo device, rate-limited.
    if (isSignificantChange(device, merged, this.settings.significantDeltaRatio)) {
      const lastFlush = this.lastFlushAt.get(deviceId) ?? 0;
      if (Date.now() - lastFlush >= MIN_EARLY_FLUSH_MS) {
        this.flushDevice(deviceId);
        return;
      }
    }

    this.schedule();
  }

  private flushDevice(deviceId: string): void {
    const entry = this.pending.get(deviceId);
    if (!entry) return;
    this.pending.delete(deviceId);
    this.commit([entry]);
    this.reschedule();
  }

  private commit(entries: readonly BufferedTelemetry[]): void {
    const fresh = entries.filter(
      (entry) => entry.seq > (this.appliedSeq.get(entry.deviceId) ?? 0),
    );
    if (fresh.length === 0) return;

    for (const entry of fresh) {
      this.appliedSeq.set(entry.deviceId, entry.seq);
    }

    // Un solo passaggio nello store per l'intero batch: i componenti che
    // osservano altri device mantengono lo stesso riferimento e non renderano.
    this.sinks.applyTelemetry(
      fresh.map(({ deviceId, decoded, at }) => ({ deviceId, decoded, at })),
    );

    const now = Date.now();
    for (const entry of fresh) {
      this.lastFlushAt.set(entry.deviceId, now);
    }
    this.stats.flushes += fresh.length;
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.disposed || this.timer !== null || this.pending.size === 0) return;

    let deadline = Number.POSITIVE_INFINITY;
    for (const entry of this.pending.values()) {
      deadline = Math.min(deadline, entry.at + this.settings.throttleMs);
    }
    if (!Number.isFinite(deadline)) return;

    const delay = Math.max(0, deadline - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
  }

  private reschedule(): void {
    this.clearTimer();
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
