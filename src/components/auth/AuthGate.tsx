import { Loader2 } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { useAuthStore } from '@/store/authStore';
import { LockScreen } from './LockScreen';

function SessionSplash() {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg text-fg-subtle"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-5 animate-spin text-accent" />
      <p className="text-[11px] uppercase tracking-wider">Verifica sessione…</p>
    </div>
  );
}

/**
 * Nessuna vista dell'app viene montata senza una sessione confermata dal
 * server. Il kiosk riparte dal cookie HttpOnly, non da dati nel localStorage.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const elevatedUntil = useAuthStore((state) => state.elevatedUntil);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Il cookie di elevazione dura 5 minuti: allo scadere il client non deve
  // continuare a mostrare Settings/Utenti come sbloccati.
  useEffect(() => {
    if (!elevatedUntil) return;
    const delay = Math.max(0, elevatedUntil - Date.now()) + 250;
    const timer = window.setTimeout(() => {
      useAuthStore.getState().clearElevation();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [elevatedUntil]);

  useEffect(() => {
    const onExpired = () => useAuthStore.getState().markAnonymous();
    window.addEventListener('domus:auth-expired', onExpired);
    return () => window.removeEventListener('domus:auth-expired', onExpired);
  }, []);

  if (status === 'loading') return <SessionSplash />;
  if (status === 'anonymous') return <LockScreen />;
  return <>{children}</>;
}
