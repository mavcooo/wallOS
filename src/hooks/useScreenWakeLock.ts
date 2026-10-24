import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Screen Wake Lock API (`navigator.wakeLock.request('screen')`).
 *
 * Sul pannello a parete lo spegnimento hardware lo decide **solo** il software
 * interno (`useKioskDimmer` / `KioskDimmerOverlay`): questo hook impedisce al
 * browser/SO di mettere lo schermo in standby dopo i pochi minuti di inattività
 * del power management, mantenendo display e ciclo di vita di WebSocket/MQTT
 * attivi H24.
 *
 * Ciclo di vita resiliente:
 * - il browser rilascia il sentinel da solo quando la scheda perde visibilità
 *   o focus (cambio app, minimizzazione): sull'evento `visibilitychange`, con
 *   il documento di nuovo visibile, la richiesta viene emessa automaticamente;
 * - l'evento `release` del sentinel aggiorna lo stato interno in ogni caso
 *   (rilascio esplicito o forzato dal browser);
 * - allo smontaggio viene rilasciato il sentinel e rimossi tutti i listener.
 *
 * L'hook è pensato per essere montato **una sola volta a livello root**
 * (`App.tsx`): non interagisce con il dimmer software, che resta l'unico
 * responsabile della "spegnimento" visivo.
 */
export interface UseScreenWakeLockReturn {
  /** `true` se il browser espone `navigator.wakeLock` (Chrome/Android WebView). */
  isSupported: boolean;
  /** `true` quando il sentinel è attivo e lo schermo non entrerà in standby. */
  isActive: boolean;
  /** Ultimo errore di richiesta/riacquisizione, se presente. */
  error: Error | null;
  /** Richiede (o riacquisisce) il blocco schermo. Idempotente. */
  requestWakeLock: () => Promise<void>;
  /** Rilascia il blocco: nessuna riacquisizione automatica finché non si richiede di nuovo. */
  releaseWakeLock: () => Promise<void>;
}

const isWakeLockSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'wakeLock' in navigator;

export function useScreenWakeLock(): UseScreenWakeLockReturn {
  const [isSupported] = useState(isWakeLockSupported);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  /**
   * Intenzione dell'app: rimane `true` anche quando il browser rilascia il
   * sentinel, così alla rientrata in `visible` si riacquisisce; `releaseWakeLock`
   * lo azzera per fermare la riacquisizione automatica.
   */
  const wantedRef = useRef(true);
  /**
   * Contatore di gara: scarta le risposte orfane di `request()` quando lo
   * smontaggio o una riacquisizione più nuova hanno già preso il controllo.
   */
  const epochRef = useRef(0);
  const mountedRef = useRef(true);

  /** Il browser (o `release()`) ha invalidato il sentinel: azzera lo stato. */
  const onRelease = useCallback(() => {
    // Rilascio forzato dal browser o esplicito: lo stato riflette il sentinel.
    sentinelRef.current = null;
    setIsActive(false);
  }, []);

  const requestWakeLock = useCallback(async (): Promise<void> => {
    wantedRef.current = true;
    if (!isSupported) return;
    // Già attivo o richiesta in volo: niente doppio sentinel.
    if (sentinelRef.current) return;

    const epoch = ++epochRef.current;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!mountedRef.current || epoch !== epochRef.current || !wantedRef.current) {
        // Lo smontaggio/una richiesta più nuova è avvenuto durante l'attesa.
        await sentinel.release().catch(() => undefined);
        return;
      }
      sentinel.addEventListener('release', onRelease);
      sentinelRef.current = sentinel;
      setError(null);
      setIsActive(true);
    } catch (cause) {
      if (!mountedRef.current || epoch !== epochRef.current) return;
      // Es. `NotAllowedError` fuori da un gesto utente o iframe senza permessi.
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setIsActive(false);
    }
  }, [isSupported, onRelease]);

  const releaseWakeLock = useCallback(async (): Promise<void> => {
    wantedRef.current = false;
    // Invalida ogni request() in volo: la risposta non deve riattivare nulla.
    epochRef.current += 1;
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel) {
      sentinel.removeEventListener('release', onRelease);
      try {
        await sentinel.release();
      } catch (cause) {
        // Sentinel già rilasciato dal browser: non è un errore per l'app.
        if (mountedRef.current) setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
    setIsActive(false);
  }, [onRelease]);

  // Mount: acquisizione automatica + riacquisizione al ritorno in `visible`.
  useEffect(() => {
    mountedRef.current = true;
    wantedRef.current = true;

    if (!isSupported) return;

    void requestWakeLock();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && wantedRef.current) {
        // Il browser ha rilasciato il sentinel uscendo da `visible`:
        // alla rientrata va richiesto di nuovo.
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      mountedRef.current = false;
      wantedRef.current = false;
      epochRef.current += 1;
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) {
        sentinel.removeEventListener('release', onRelease);
        void sentinel.release().catch(() => undefined);
      }
      setIsActive(false);
    };
  }, [isSupported, requestWakeLock, onRelease]);

  return { isSupported, isActive, error, requestWakeLock, releaseWakeLock };
}