import { MQTT_WATCHDOG } from '@/config/app.config';

/**
 * Heartbeat applicativo e watchdog anti-freeze per il client MQTT del kiosk.
 *
 * Contesto: su display fissi H24 il broker (o l'access point) può interrompere
 * la sessione TCP senza consegnare FIN/RST al browser. mqtt.js continua a
 * credere che il socket sia valido (`client.connected === true`), il badge
 * resta verde e ogni comando finisce nel vuoto. L'unica difesa affidabile è a
 * livello applicativo: si misura il tempo trascorso dall'ultimo pacchetto
 * realmente ricevuto e, oltre la soglia, la socket "zombie" viene distrutta e
 * la connessione ripartita da zero.
 *
 * Fasi della macchina di stato:
 * - `ok`        → traffico recente, tutto normale;
 * - `frozen`    → silenzio oltre `freezeTimeoutMs`: `onFreeze` forza la
 *                 riconnessione (`end(true)` + nuova istanza);
 * - `countdown` → il blackout persiste oltre `blackoutTimeoutMs`: parte il
 *                 countdown di `reloadCountdownMs` e poi `onReload`.
 *
 * Qualsiasi pacchetto valido (`noteActivity`) riporta la macchina in `ok` e
 * azzera sia il freeze sia il blackout.
 */

export type WatchdogPhase = 'ok' | 'frozen' | 'countdown';

export interface MqttWatchdogOptions {
  heartbeatIntervalMs?: number;
  /** Silenzio massimo prima di dichiarare il socket zombie (default 90 s). */
  freezeTimeoutMs?: number;
  /** Blackout continuo dopo cui si prepara il riavvio (default 10 min). */
  blackoutTimeoutMs?: number;
  /** Durata del countdown mostrato prima di `window.location.reload()`. */
  reloadCountdownMs?: number;
  /** Frequenza del controllo di silenzio (default 10 s). */
  checkIntervalMs?: number;
  /** Ogni quanto pubblicare il ping heartbeat (default 30 s). */
  sendHeartbeat(): void;
  /** Distrugge la socket zombie e riapre la connessione. */
  onFreeze(silenceMs: number): void;
  /** Retry manuale ("Riprova Ora"): riapre la socket senza toast di freeze. */
  onRetry?(): void;
  /** Aggiorna la UI del countdown (chiamato ogni secondo durante la fase). */
  onCountdown(remainingMs: number): void;
  /** Riavvio definitivo dell'applicazione. */
  onReload(): void;
  /** Notifica di fase per badge/toast (opzionale). */
  onPhaseChange?(phase: WatchdogPhase, silenceMs: number): void;
  /** Clock iniettabile per i test. */
  now?(): number;
}

export interface MqttWatchdog {
  /** Registra un pacchetto valido: pong, echo, qualsiasi messaggio MQTT. */
  noteActivity(at?: number): void;
  /** Valutazione immediata (eventi `online`/`offline`, retry manuale). */
  checkNow(): void;
  /** Spegne heartbeat, tick e countdown (unmount / cambio broker). */
  stop(): void;
  /** L'utente ha annullato il riavvio: il countdown non ricomincia. */
  cancelReload(): void;
  /** L'utente chiede un tentativo immediato: riapre la socket e riparte il clock. */
  retryNow(): void;
  phase(): WatchdogPhase;
  /** Epoch ms dell'ultimo pacchetto valido ricevuto. */
  lastActivityAt(): number;
  silenceMs(): number;
}

export interface HeartbeatEcho {
  clientId?: string;
  timestamp: number;
}

/**
 * Parsing del payload di heartbeat accettato: JSON `{"clientId","timestamp"}`
 * oppure il timestamp nudo usato dal loopback legacy. `null` = payload da
 * scartare (non deve aggiornare il clock del watchdog).
 */
export function parseHeartbeatEcho(payload: string): HeartbeatEcho | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const timestamp = typeof record.timestamp === 'number' ? record.timestamp : NaN;
        if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
        return {
          timestamp,
          ...(typeof record.clientId === 'string' ? { clientId: record.clientId } : {}),
        };
      }
    } catch {
      return null;
    }
  }

  const legacy = Number.parseInt(trimmed, 10);
  return Number.isFinite(legacy) && legacy > 0 ? { timestamp: legacy } : null;
}

/** Payload del ping heartbeat: timestamped, con clientId per il debug sul broker. */
export function heartbeatPingPayload(clientId: string, at: number = Date.now()): string {
  return JSON.stringify({ clientId, timestamp: at });
}

export function createMqttWatchdog(options: MqttWatchdogOptions): MqttWatchdog {
  const {
    heartbeatIntervalMs = MQTT_WATCHDOG.heartbeatIntervalMs,
    freezeTimeoutMs = MQTT_WATCHDOG.freezeTimeoutMs,
    blackoutTimeoutMs = MQTT_WATCHDOG.blackoutTimeoutMs,
    reloadCountdownMs = MQTT_WATCHDOG.reloadCountdownMs,
    checkIntervalMs = MQTT_WATCHDOG.checkIntervalMs,
    sendHeartbeat,
    onFreeze,
    onRetry,
    onCountdown,
    onReload,
    onPhaseChange,
    now = () => Date.now(),
  } = options;

  let lastActivity = now();
  let currentPhase: WatchdogPhase = 'ok';
  let reloadCancelled = false;
  let stopped = false;
  let heartbeatTimer: number | undefined;
  let checkTimer: number | undefined;
  let reloadTimer: number | undefined;

  function setPhase(next: WatchdogPhase, silence: number): void {
    if (currentPhase === next) return;
    currentPhase = next;
    onPhaseChange?.(next, silence);
  }

  function startCountdown(): void {
    if (reloadCancelled || reloadTimer !== undefined) return;
    let remaining = reloadCountdownMs;
    onCountdown(remaining);
    reloadTimer = window.setInterval(() => {
      if (stopped) return;
      remaining -= 1_000;
      if (remaining <= 0) {
        window.clearInterval(reloadTimer);
        reloadTimer = undefined;
        onReload();
        return;
      }
      onCountdown(remaining);
    }, 1_000);
  }

  /**
   * Valuta silenzio e blackout. È l'unico punto che muta la fase: lo tick
   * periodico, `online`/`offline` e il retry manuale lo invocano tutti.
   */
  function evaluate(): void {
    if (stopped) return;
    const silence = now() - lastActivity;

    if (currentPhase === 'ok' && silence > freezeTimeoutMs) {
      setPhase('frozen', silence);
      onFreeze(silence);
    }

    // Il blackout si misura dal silenzio totale, non da quando è partito il
    // tentativo di riconnessione: 10 minuti senza nessun pacchetto.
    if (silence > blackoutTimeoutMs) {
      setPhase('countdown', silence);
      startCountdown();
    }
  }

  heartbeatTimer = window.setInterval(() => {
    if (stopped) return;
    sendHeartbeat();
  }, heartbeatIntervalMs);
  // Il primo ping parte subito: la connessione appena aperta deve risultare viva
  // anche prima del primo tick.
  sendHeartbeat();

  checkTimer = window.setInterval(evaluate, checkIntervalMs);

  return {
    noteActivity(at = now()) {
      if (stopped) return;
      lastActivity = at;
      // Tutto torna a verde: il countdown (se non annullato) si ferma perché la
      // connessione è di nuovo valida. L'eventuale annullamento vale solo per
      // il blackout corrente: un nuovo blackout riparte con il countdown armato.
      if (reloadTimer !== undefined) {
        window.clearInterval(reloadTimer);
        reloadTimer = undefined;
      }
      reloadCancelled = false;
      setPhase('ok', 0);
    },
    checkNow: evaluate,
    stop() {
      stopped = true;
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      if (checkTimer !== undefined) window.clearInterval(checkTimer);
      if (reloadTimer !== undefined) window.clearInterval(reloadTimer);
      heartbeatTimer = undefined;
      checkTimer = undefined;
      reloadTimer = undefined;
    },
    cancelReload() {
      reloadCancelled = true;
      if (reloadTimer !== undefined) {
        window.clearInterval(reloadTimer);
        reloadTimer = undefined;
      }
    },
    retryNow() {
      // Un retry manuale riapre la socket: il silenzio ricomincia a contare da
      // zero e, se il blackout prosegue, il countdown riparte dall'inizio.
      reloadCancelled = false;
      lastActivity = now();
      if (reloadTimer !== undefined) {
        window.clearInterval(reloadTimer);
        reloadTimer = undefined;
      }
      setPhase('ok', 0);
      onRetry?.();
      evaluate();
    },
    phase: () => currentPhase,
    lastActivityAt: () => lastActivity,
    silenceMs: () => now() - lastActivity,
  };
}
