import { useEffect, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { KioskDimmerOverlay } from '@/components/kiosk/KioskDimmerOverlay';
import { useKioskDimmer } from '@/hooks/useKioskDimmer';
import { usePixelShift } from '@/hooks/usePixelShift';
import { useHomeStore } from '@/store/homeStore';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

interface AppShellProps {
  children: ReactNode;
  /** Attributi extra del contenitore scrollabile: usato per le gesture di swipe. */
  mainProps?: ComponentProps<'main'>;
}

export function AppShell({ children, mainProps }: AppShellProps) {
  const timeoutMs = useHomeStore((state) => state.ui.dimmerTimeoutMs);
  const burnIn = useHomeStore((state) => state.burnIn);
  const { isDimmed, sleep } = useKioskDimmer({ timeoutMs });

  // Micro-spostamento della dashboard mentre la UI è attiva: 1-4 px attorno
  // all'origine, solo `transform`. Si azzera appena parte il dimmer, perché
  // sotto l'overlay nero non c'è nulla da proteggere.
  const shift = usePixelShift({
    mode: 'subtle-shift',
    intervalMs: burnIn.shiftIntervalMs,
    enabled: !isDimmed,
  });

  // Permette a qualsiasi pagina (es. Impostazioni) di testare lo standby.
  useEffect(() => {
    const handler = () => sleep();
    window.addEventListener('domus:kiosk-sleep', handler);
    return () => window.removeEventListener('domus:kiosk-sleep', handler);
  }, [sleep]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg">
      {/* Il contenuto trasla dentro un contenitore che clippa: nessun bordo scoperto. */}
      <div className="flex h-full w-full" style={shift.style}>
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header onStandby={sleep} />
          <main
            {...mainProps}
            className={cn(
              'kiosk-scroll min-h-0 flex-1 px-4 pb-8 pt-4 lg:px-6',
              mainProps?.className,
            )}
          >
            {children}
          </main>
        </div>
      </div>
      <KioskDimmerOverlay
        visible={isDimmed}
        mode={burnIn.mode}
        shiftIntervalMs={burnIn.shiftIntervalMs}
        clockOpacity={burnIn.dimClockOpacity}
      />
    </div>
  );
}
