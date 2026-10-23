import { Lock } from 'lucide-react';

import { AuthGate } from '@/components/auth/AuthGate';
import { RequireRole } from '@/components/auth/RequireRole';
import { TopologyGate } from '@/components/auth/TopologyGate';
import { AppShell } from '@/components/layout/AppShell';
import { DatabaseHealthMonitor } from '@/components/layout/DatabaseHealthMonitor';
import { PinProvider } from '@/components/kiosk/PinProvider';
import { Toaster } from '@/components/kiosk/Toaster';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { MqttProvider } from '@/mqtt/MqttProvider';
import { AdminPage } from '@/pages/AdminPage';
import { EnergyPage } from '@/pages/EnergyPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { RoomsPage } from '@/pages/RoomsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { UsersPage } from '@/pages/UsersPage';
import { useHomeStore } from '@/store/homeStore';

function AccessDenied({ view }: { view: string }) {
  const setView = useHomeStore((state) => state.setView);
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-panel text-fg-subtle">
        <Lock className="size-5" />
      </span>
      <p className="text-sm font-medium text-fg">Vista “{view}” non consentita</p>
      <p className="max-w-sm text-xs text-fg-subtle">
        Il ruolo del profilo attivo non ha i permessi per questa schermata. Le impostazioni e
        i profili del kiosk si sbloccano con il PIN del dispositivo.
      </p>
      <button
        type="button"
        onClick={() => setView('overview')}
        className="mt-2 h-10 rounded-xl border border-line px-4 text-xs font-medium text-fg-muted hover:text-fg"
      >
        Torna alla overview
      </button>
    </div>
  );
}

function CurrentView() {
  const view = useHomeStore((state) => state.ui.view);
  const user = useCurrentUser();

  if (view === 'energy' && user.restrictions.energy) {
    return <AccessDenied view="Consumi" />;
  }

  switch (view) {
    case 'overview':
      return <OverviewPage />;
    case 'rooms':
      return <RoomsPage />;
    case 'energy':
      return <EnergyPage />;
    case 'settings':
      return (
        <RequireRole
          roles={['admin', 'family']}
          allowElevated
          fallback={<AccessDenied view="Impostazioni" />}
        >
          <SettingsPage />
        </RequireRole>
      );
    case 'users':
      return (
        <RequireRole
          roles={['admin', 'family']}
          allowElevated
          fallback={<AccessDenied view="Utenti e profili" />}
        >
          <UsersPage />
        </RequireRole>
      );
    case 'admin':
      return (
        <RequireRole roles={['admin']} fallback={<AccessDenied view="Amministrazione" />}>
          <AdminPage />
        </RequireRole>
      );
  }
}

export default function App() {
  const view = useHomeStore((state) => state.ui.view);

  return (
    <>
      {/* Health del database a livello applicazione: notifiche e badge anche
          sul lock screen, prima che la topologia sia caricata. */}
      <DatabaseHealthMonitor />
      <AuthGate>
        <TopologyGate>
          <PinProvider>
            <MqttProvider>
              <AppShell>
                <div key={view} className="animate-rise">
                  <CurrentView />
                </div>
              </AppShell>
            </MqttProvider>
          </PinProvider>
        </TopologyGate>
      </AuthGate>
      <Toaster />
    </>
  );
}
