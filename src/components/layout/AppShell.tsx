import { useEffect, type ReactNode } from 'react';

import { KioskDimmerOverlay } from '@/components/kiosk/KioskDimmerOverlay';
import { useKioskDimmer } from '@/hooks/useKioskDimmer';
import { useHomeStore } from '@/store/homeStore';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const timeoutMs = useHomeStore((state) => state.ui.dimmerTimeoutMs);
  const { isDimmed, sleep } = useKioskDimmer({ timeoutMs });

  // Permette a qualsiasi pagina (es. Impostazioni) di testare lo standby.
  useEffect(() => {
    const handler = () => sleep();
    window.addEventListener('domus:kiosk-sleep', handler);
    return () => window.removeEventListener('domus:kiosk-sleep', handler);
  }, [sleep]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onStandby={sleep} />
        <main className="kiosk-scroll min-h-0 flex-1 px-4 pb-8 pt-4 lg:px-6">{children}</main>
      </div>
      <KioskDimmerOverlay visible={isDimmed} />
    </div>
  );
}
