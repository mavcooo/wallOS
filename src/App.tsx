import { Lock } from 'lucide-react';
import { useEffect } from 'react';

import { AppShell } from '@/components/layout/AppShell';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { PinProvider } from '@/components/kiosk/PinProvider';
import { Toaster } from '@/components/kiosk/Toaster';
import { MqttProvider } from '@/mqtt/MqttProvider';
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
        Il profilo attivo non ha i permessi per questa schermata. Cambia profilo dalla voce
        Utenti (richiede PIN).
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
  // La vista Utenti resta raggiungibile dal chip profilo: senza di essa un
  // profilo ristretto non potrebbe più cambiare (il cambio è protetto da PIN).
  const denied =
    (view === 'settings' && user.restrictions.settings) ||
    (view === 'energy' && user.restrictions.energy);
  if (denied) return <AccessDenied view={view} />;
  switch (view) {
    case 'overview':
      return <OverviewPage />;
    case 'rooms':
      return <RoomsPage />;
    case 'energy':
      return <EnergyPage />;
    case 'settings':
      return <SettingsPage />;
    case 'users':
      return <UsersPage />;
  }
}

export default function App() {
  const view = useHomeStore((state) => state.ui.view);

  useEffect(() => {
    // Genera l'hash del PIN di fabbrica al primo avvio (mai in chiaro nello store).
    void useHomeStore.getState().ensurePin();
  }, []);

  return (
    <PinProvider>
      <MqttProvider>
        <AppShell>
          <div key={view} className="animate-rise">
            <CurrentView />
          </div>
        </AppShell>
        <Toaster />
      </MqttProvider>
    </PinProvider>
  );
}
