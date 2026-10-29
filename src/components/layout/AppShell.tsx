import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { KioskDimmerOverlay } from '@/components/kiosk/KioskDimmerOverlay';
import { useCompactViewport } from '@/hooks/useCompactViewport';
import { useKioskDimmer } from '@/hooks/useKioskDimmer';
import { usePixelShift } from '@/hooks/usePixelShift';
import { useHomeStore } from '@/store/homeStore';
import { selectActiveAlarmCount, useSecurityStore } from '@/store/securityStore';
import { selectCriticalCount, useToastStore } from '@/store/toastStore';
import { BottomNav } from './BottomNav';
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
  // Ponte store → dimmer: un allarme di sicurezza **persistito** ancora aperto
  // blocca il countdown. Il conteggio viene da `/api/security/state`, quindi
  // resta valido anche dopo un reload o un riavvio del tablet. Agli allarmi di
  // sicurezza si aggiungono gli avvisi di sistema bloccanti (broker/database
  // irraggiungibili), che restano notifiche locali.
  const securityAlarms = useSecurityStore(selectActiveAlarmCount);
  const systemAlerts = useToastStore(selectCriticalCount);
  const activeAlarms = securityAlarms + systemAlerts;
  const { isDimmed, sleep, wake } = useKioskDimmer({ timeoutMs, hold: activeAlarms > 0 });
  // Una sola shell alla volta: sotto i 768px la Sidebar non viene montata e al
  // suo posto compare la Bottom Navigation. Il CSS (`hidden md:flex` /
  // `md:hidden`) resta come seconda barriera, ma il gate JS evita due alberi di
  // navigazione nello stesso documento (nomi accessibili duplicati, tab stop
  // doppi, test ambigui).
  const compact = useCompactViewport();

  // L'allarme deve trovare lo schermo acceso: il risveglio usa la stessa
  // pipeline del tap, quindi l'overlay è subito visibile e toccabile.
  useEffect(() => {
    if (activeAlarms > 0) wake();
  }, [activeAlarms, wake]);

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
      if (activeAlarms === 0) sleep();
    };
    window.addEventListener('domus:kiosk-sleep', handler);
    return () => window.removeEventListener('domus:kiosk-sleep', handler);
  }, [activeAlarms, sleep]);

  return (
    // Root vincolata all'altezza della viewport: l'unico contenitore che
    // scrolla è <main>, il body non si muove (niente rimbalzo né scrollbar
    // del documento sui browser touch). `w-full` invece di `w-screen`: con
    // `overflow-hidden` una scrollbar lascerebbe comunque una striscia.
    <div className="flex h-dvh max-h-dvh w-full select-none flex-col overflow-hidden bg-bg text-fg">
      {/* Il contenuto trasla dentro un contenitore che clippa: nessun bordo scoperto. */}
      <div className="flex h-full min-h-0 w-full flex-col md:flex-row" style={shift.style}>
        {compact ? null : <Sidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Header onStandby={sleep} />
          {/* Safe boot: spiega perché i widget sono fermi durante l'idratazione. */}
          <HydrationBanner />
          <main
            {...mainProps}
            ref={setMainRef}
            className={cn(
              // `scrollbar-none`: nessuna barra nativa sul pannello kiosk, lo
              // scroll (inerziale sul touch) resta. `overflow-x-hidden` evita
              // che un contenuto più largo della colonna generi un pan
              // orizzontale: il layout deve adattarsi, non scorrere di lato.
              'scrollbar-none min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 pt-4 lg:px-6',
              mainProps?.className,
            )}
          >
            {/* Larghezza massima centrata: su un 1920px le card non si
                allargano all'infinito, su tablet la colonna usa tutto lo
                spazio disponibile. */}
            <div className="mx-auto w-full max-w-7xl">
              <ScrollContainerProvider value={scrollContext}>{children}</ScrollContainerProvider>
            </div>
          </main>
        </div>
        {/* Fuori dallo scroll (flex sibling): la barra non si muove con la
            pagina e non copre l'ultima card. Montata solo sul viewport
            compatto, così sul pannello a parete non esistono due alberi di
            navigazione (nomi accessibili e tab stop doppi). */}
        {compact ? <BottomNav /> : null}
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
