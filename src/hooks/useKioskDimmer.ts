import { useCallback, useEffect, useRef, useState } from 'react';

import { KIOSK_DEFAULTS } from '@/config/app.config';
import { useHomeStore } from '@/store/homeStore';

export type DimmerPhase = 'awake' | 'dimmed';

export interface KioskDimmerOptions {
  /** Inattività prima dello sleep (default 2 min). */
  timeoutMs?: number;
  /** Durata della transizione verso il nero. */
  fadeMs?: number;
  enabled?: boolean;
  /**
   * Congela il timer di inattività (es. allarme critico attivo): lo schermo
   * resta acceso e non può rioscursi da solo durante un'emergenza.
   */
  hold?: boolean;
}

export interface KioskDimmerApi {
  phase: DimmerPhase;
  isDimmed: boolean;
  /** Secondi rimanenti allo sleep (per debug/diagnostica). */
  secondsToSleep: number;
  /** Forza il risveglio (stessa pipeline del tap). */
  wake: () => void;
  /** Forza lo sleep (utile per il tasto "standby" nell'header). */
  sleep: () => void;
  /** Registra attività manuale (es. tap su uno slider). */
  registerActivity: () => void;
}

/**
 * useKioskDimmer
 * --------------------------------------------------------------------------
 * Kiosk-safe screensaver:
 * 1. ascolta attività reali (pointerdown, touchstart/touchmove, mousemove,
 *    keydown, wheel) e resetta il timer;
 * 2. dopo `timeoutMs` entra in `dimmed` mostrando un overlay nero;
 * 3. al primo tocco consuma l'evento in fase di capture (`stopPropagation`),
 *    così il tap di risveglio NON attiva pulsanti sottostanti;
 * 4. per `wakeGuardMs` assorbe anche pointerup/click residui, evitando comandi
 *    accidentali sul widget che si trovava sotto il dito.
 */
export function useKioskDimmer(options: KioskDimmerOptions = {}): KioskDimmerApi {
  const {
    timeoutMs = KIOSK_DEFAULTS.dimmerTimeoutMs,
    enabled = true,
    hold = false,
  } = options;

  const [phase, setPhase] = useState<DimmerPhase>('awake');
  const [secondsToSleep, setSecondsToSleep] = useState(Math.round(timeoutMs / 1000));
  const lastActivityRef = useRef(Date.now());
  const phaseRef = useRef<DimmerPhase>('awake');
  const guardUntilRef = useRef(0);
  const setScreenDimmed = useHomeStore((state) => state.setScreenDimmed);

  const applyPhase = useCallback(
    (next: DimmerPhase) => {
      phaseRef.current = next;
      setPhase(next);
      setScreenDimmed(next === 'dimmed');
    },
    [setScreenDimmed],
  );

  const registerActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (phaseRef.current === 'awake') setSecondsToSleep(Math.round(timeoutMs / 1000));
  }, [timeoutMs]);

  const wake = useCallback(() => {
    lastActivityRef.current = Date.now();
    guardUntilRef.current = performance.now() + KIOSK_DEFAULTS.wakeGuardMs;
    applyPhase('awake');
  }, [applyPhase]);

  const sleep = useCallback(() => {
    applyPhase('dimmed');
  }, [applyPhase]);

  // Un allarme attivo sveglia subito il pannello e sospende il countdown.
  useEffect(() => {
    if (!hold) return;
    lastActivityRef.current = Date.now();
    applyPhase('awake');
  }, [applyPhase, hold]);

  useEffect(() => {
    if (!enabled) {
      applyPhase('awake');
      return;
    }
    lastActivityRef.current = Date.now();

    const onActivity = (event: Event) => {
      // Il tocco che sveglia viene consumato: nessun comando accidentale.
      if (phaseRef.current === 'dimmed') {
        event.preventDefault();
        event.stopPropagation();
        wake();
        return;
      }
      lastActivityRef.current = Date.now();
    };

    const swallow = (event: Event) => {
      if (performance.now() < guardUntilRef.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    // `touchmove`/`mousemove` mancavano: su tablet e smartphone uno swipe o un
    // movimento continuo non resettava l'inattività, quindi lo schermo poteva
    // oscurarsi sotto il dito. `pointerdown` resta il segnale principale (già
    // intercettato in capture sul layer di standby).
    const events = [
      'pointerdown',
      'keydown',
      'wheel',
      'touchstart',
      'touchmove',
      'mousemove',
    ] as const;
    for (const name of events) {
      window.addEventListener(name, onActivity, { capture: true, passive: false });
    }
    window.addEventListener('pointerup', swallow, { capture: true });
    window.addEventListener('click', swallow, { capture: true });

    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // Finché c'è un allarme non tacitato il timer resta fermo al massimo.
      if (hold) {
        lastActivityRef.current = Date.now();
        setSecondsToSleep(Math.round(timeoutMs / 1000));
        return;
      }
      if (phaseRef.current === 'dimmed') {
        setSecondsToSleep(0);
        return;
      }
      const remaining = timeoutMs - (Date.now() - lastActivityRef.current);
      setSecondsToSleep(Math.max(0, Math.ceil(remaining / 1000)));
      if (remaining <= 0) applyPhase('dimmed');
    }, 500);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') lastActivityRef.current = Date.now();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      for (const name of events) window.removeEventListener(name, onActivity, { capture: true });
      window.removeEventListener('pointerup', swallow, { capture: true });
      window.removeEventListener('click', swallow, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(tick);
    };
  }, [applyPhase, enabled, hold, timeoutMs, wake]);

  return {
    phase,
    isDimmed: phase === 'dimmed',
    secondsToSleep,
    wake,
    sleep,
    registerActivity,
  };
}
