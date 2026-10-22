import { useEffect, useState } from 'react';

/** Orologio reattivo con tick allineato all'intervallo richiesto. */
export function useClock(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timeout = 0;
    let interval = 0;

    // Allinea il primo tick al secondo successivo per un orologio senza drift.
    const delay = intervalMs - (Date.now() % intervalMs);
    timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), intervalMs);
    }, delay);

    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [intervalMs]);

  return now;
}
