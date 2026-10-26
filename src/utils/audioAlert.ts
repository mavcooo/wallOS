/**
 * Sirena locale per gli allarmi critici.
 *
 * Sintesi pura con Web Audio API: nessun file audio da scaricare, quindi il
 * pannello suona anche offline. L'AudioContext vive in un singleton perché il
 * browser ne consente un numero limitato e perché `playAlarm`/`stopAlarm`
 * devono essere richiamabili da qualunque punto (store, overlay, test).
 */

export type AlarmPattern = 'siren' | 'warning_beep';

/** Intervallo fra due raffiche: la sirena resta udibile senza essere continua. */
const REPEAT_MS: Record<AlarmPattern, number> = {
  siren: 2_000,
  warning_beep: 3_000,
};

/** Picco di ciascun tono: alto ma non distorto sugli speaker del tablet. */
const PEAK_GAIN = 0.22;
/** Volume generale della sirena. */
const MASTER_GAIN = 0.45;

class AlarmAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private pattern: AlarmPattern | null = null;

  /**
   * Crea l'AudioContext alla prima richiesta. Nei browser senza Web Audio
   * (o in jsdom durante i test) restituisce `null` e tutto diventa no-op.
   */
  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (this.context) return this.context;

    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    try {
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.master.connect(this.context.destination);
    } catch {
      this.context = null;
      this.master = null;
    }
    return this.context;
  }

  /**
   * Sblocca l'AudioContext sospeso dall'autoplay policy. Va richiamato da un
   * gesto utente: il primo tap sul pannello è sufficiente.
   */
  async unlock(): Promise<void> {
    const context = this.ensureContext();
    if (!context || context.state !== 'suspended') return;
    try {
      await context.resume();
    } catch {
      // Il prossimo gesto riproverà: nessun errore da propagare alla UI.
    }
  }

  /** Un tono con inviluppo graduale: evita il click digitale di attacco/rilascio. */
  private tone(
    frequency: number,
    startAt: number,
    duration: number,
    type: OscillatorType,
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);

    const endAt = startAt + duration;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + 0.02);
    gain.gain.setValueAtTime(PEAK_GAIN, Math.max(startAt + 0.03, endAt - 0.06));
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(startAt);
    // Un margine oltre la fine dell'inviluppo: lo stop non tronca il fade-out.
    oscillator.stop(endAt + 0.05);
  }

  /** Una raffica del pattern corrente. */
  private burst(): void {
    const context = this.context;
    if (!context || !this.pattern) return;

    const now = context.currentTime + 0.02;
    if (this.pattern === 'warning_beep') {
      this.tone(880, now, 0.18, 'sine');
      return;
    }

    // Sirena: due frequenze alternate, onda quadra per bucare il rumore ambientale.
    this.tone(880, now, 0.32, 'square');
    this.tone(1_760, now + 0.36, 0.32, 'square');
    this.tone(880, now + 0.72, 0.32, 'square');
  }

  /**
   * Avvia (o riavvia) la sirena. Chiamate ripetute con lo stesso pattern
   * ripartono da capo invece di sovrapporre più timer.
   */
  playAlarm(pattern: AlarmPattern = 'siren'): void {
    this.stopAlarm();
    this.pattern = pattern;
    void this.unlock();
    this.burst();
    this.timer = window.setInterval(() => this.burst(), REPEAT_MS[pattern]);
  }

  /** Ferma sirena e timer. Idempotente. */
  stopAlarm(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.pattern = null;
  }

  get isPlaying(): boolean {
    return this.timer !== null;
  }
}

export const audioAlert = new AlarmAudio();

let unlockBound = false;

/**
 * Registra una sola volta lo sblocco audio sul primo gesto utente. Il pannello
 * kiosk riceve tap continui, quindi il caso "sirena muta perché l'AudioContext
 * non è ancora sbloccato" dura al massimo fino al tocco successivo.
 */
export function bindAudioUnlockOnFirstGesture(): void {
  if (unlockBound || typeof window === 'undefined') return;
  unlockBound = true;

  const unlock = () => {
    void audioAlert.unlock();
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
  window.addEventListener('touchstart', unlock, { once: true, capture: true, passive: true });
}
