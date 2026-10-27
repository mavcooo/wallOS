import { BATTERY_GUARDIAN } from '@/config/app.config';

/**
 * Diagnostica del browser per i pannelli accesi H24.
 *
 * Un tablet a parete non viene mai riavviato: la pagina resta aperta per
 * settimane e la memoria heap cresce finché Chromium non rallenta o si
 * impalla. Qui stanno le letture che servono a vederlo arrivare — heap
 * JavaScript e frame rate — isolate dal DOM per poter essere testate.
 */

/** Fotografia dell'heap JavaScript (`performance.memory`, solo Chromium). */
export interface HeapMemorySample {
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
}

/**
 * `performance.memory` è **non standard**: esiste su Chrome/Edge/WebView
 * Android, non su Safari/iPadOS e Firefox. Il tipo non è nei lib DOM, quindi
 * lo si descrive qui invece di usare `any`.
 */
interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize?: unknown;
    totalJSHeapSize?: unknown;
    jsHeapSizeLimit?: unknown;
  };
}

function readNumber(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : null;
}

/**
 * Heap in byte, o `null` dove l'API non c'è: la diagnostica mostra "n/d"
 * invece di un numero inventato, e il watchdog non emette falsi allarmi.
 */
export function readHeapMemory(target?: Performance): HeapMemorySample | null {
  const source = (target ?? globalThis.performance) as PerformanceWithMemory | undefined;
  const memory = source?.memory;
  if (!memory) return null;

  const usedBytes = readNumber(memory.usedJSHeapSize, 0);
  const limitBytes = readNumber(memory.jsHeapSizeLimit, 1);
  if (usedBytes === null || limitBytes === null) return null;

  return {
    usedBytes,
    totalBytes: readNumber(memory.totalJSHeapSize, usedBytes) ?? usedBytes,
    limitBytes,
  };
}

/** Quota di heap in uso (0-1): oltre `BATTERY_GUARDIAN.heapWarnRatio` si avvisa. */
export function heapUsageRatio(sample: HeapMemorySample | null): number | null {
  if (!sample || sample.limitBytes <= 0) return null;
  return Math.min(1, Math.max(0, sample.usedBytes / sample.limitBytes));
}

/**
 * Frame rate medio su una finestra breve di `requestAnimationFrame`.
 *
 * Si misura a campioni (una finestra da un secondo ogni tanto) invece di
 * tenere un contatore perpetuo: il pannello gira H24 e un loop rAF sempre
 * attivo sarebbe proprio il tipo di lavoro che si vuole misurare.
 *
 * Restituisce `0` dove rAF non è disponibile (ambienti di test minimali).
 */
export function sampleFrameRate(
  windowMs: number = BATTERY_GUARDIAN.fpsWindowMs,
): Promise<number> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve(0);

  const startedAt = performance.now();
  let frames = 0;

  return new Promise<number>((resolve) => {
    const tick = () => {
      frames += 1;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= windowMs) {
        resolve(elapsed > 0 ? Math.round((frames * 1_000) / elapsed) : 0);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
