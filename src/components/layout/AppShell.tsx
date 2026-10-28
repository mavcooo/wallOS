import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { KioskDimmerOverlay } from '@/components/kiosk/KioskDimmerOverlay';
import { useKioskDimmer } from '@/hooks/useKioskDimmer';
import { usePixelShift } from '@/hooks/usePixelShift';
import { useHomeStore } from '@/store/homeStore';
import { selectCriticalCount, useToastStore } from '@/store/toastStore';
import { Header } from './Header';
import { HydrationBanner } from './HydrationBanner';
import { ScrollContainerProvider } from './ScrollContainerContext';
import { Sidebar } from './Sidebar';

interface AppShellProps {
  children: ReactNode;
  /** Attributi extra del contenitore scrollabile: usato per le gesture di swipe. */
  mainProps?: ComponentProps<'main'>;
}

export function AppShell({ children, mainProps }: AppShellProps) {
  // Le griglie virtualizzate scrollano insieme alla pagina: ricevono il <main>
  // tramite contesto, mentre `revision` le avvisa quando una di loro cambia
  // altezza e sposta l'offset delle successive.
  const mainRef = useRef<HTMLElement>(null);
  // `mainProps` porta anche il ref di react-swipeable: va concatenato, non
  // sovrascritto, altrimenti la gesture orizzontale perde il suo listener.
  const externalMainRef = mainProps?.ref;
  const setMainRef = useCallback(
    (node: HTMLElement | null) => {
      mainRef.current = node;
      if (typeof externalMainRef === 'function') externalMainRef(node);
      else if (externalMainRef) externalMainRef.current = node;
    },
    [externalMainRef],
  );

  const [revision, setRevision] = useState(0);
  const notifyLayoutChange = useCallback(() => setRevision((value) => value + 1), []);
  const scrollContext = useMemo(
    () => ({ ref: mainRef, revision, notifyLayoutChange }),
    [revision, notifyLayoutChange],
  );

  const timeoutMs = useHomeStore((state) => state.ui.dimmerTimeoutMs);
  const burnIn = useHomeStore((state) => state.burnIn);
  // Ponte store → dimmer: un allarme critico attivo blocca il countdown.
  const criticalCount = useToastStore(selectCriticalCount);
  const { isDimmed, sleep, wake } = useKioskDimmer({ timeoutMs, hold: criticalCount > 0 });

  // L'allarme deve trovare lo schermo acceso: il risveglio usa la stessa
  // pipeline del tap, quindi l'overlay è subito visibile e toccabile.
  useEffect(() => {
    if (criticalCount > 0) wake();
  }, [criticalCount, wake]);

  // Micro-spostamento della dashboard mentre la UI è attiva: 1-4 px attorno
  // all'origine, solo `transform`. Si azzera appena parte il dimmer, perché
  // sotto l'overlay nero non c'è nulla da proteggere.
  const shift = usePixelShift({
    mode: 'subtle-shift',
    intervalMs: burnIn.shiftIntervalMs,
    enabled: !isDimmed,
  });

  // La modale di emergenza (blackout di rete > 10 min) può chiedere il
  // risveglio: l'evento è l'unico ponte fra il watchdog e il dimmer, così
  // l'heartbeat normale non sveglia mai lo schermo da solo.
  useEffect(() => {
    const handleWake = () => wake();
    window.addEventListener('domus:kiosk-wake', handleWake);
    return () => window.removeEventListener('domus:kiosk-wake', handleWake);
  }, [wake]);

  // Permette a qualsiasi pagina (es. Impostazioni) di testare lo standby.
  // Durante un allarme lo standby manuale è ignorato: il pannello resta acceso.
  useEffect(() => {
    const handler = () => {
      if (criticalCount === 0) sleep();
    };
    window.addEventListener('domus:kiosk-sleep', handler);
    return () => window.removeEventListener('domus:kiosk-sleep', handler);
  }, [criticalCount, sleep]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg">
      {/* Il contenuto trasla dentro un contenitore che clippa: nessun bordo scoperto. */}
      <div className="flex h-full w-full" style={shift.style}>
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header onStandby={sleep} />
          {/* Safe boot: spiega perché i widget sono fermi durante l'idratazione. */}
          <HydrationBanner />
          <main
            {...mainProps}
            ref={setMainRef}
            className={cn(
              'kiosk-scroll min-h-0 flex-1 px-4 pb-8 pt-4 lg:px-6',
              mainProps?.className,
            )}
          >
            <ScrollContainerProvider value={scrollContext}>{children}</ScrollContainerProvider>
          </main>
        </div>
      </div>
      <KioskDimmerOverlay
        visible={isDimmed}
        // Il tap di risveglio è consumato dall'overlay prima di arrivare qui:
        // `wake` cambia solo lo stato del dimmer, nessun comando domotico.
        onWake={wake}
        mode={burnIn.mode}
        shiftIntervalMs={burnIn.shiftIntervalMs}
        clockOpacity={burnIn.dimClockOpacity}
      />
    </div>
  );
}
