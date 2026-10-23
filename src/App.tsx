import { Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthGate } from '@/components/auth/AuthGate';
import { RequireRole } from '@/components/auth/RequireRole';
import { TopologyGate } from '@/components/auth/TopologyGate';
import { AppShell } from '@/components/layout/AppShell';
import { DatabaseHealthMonitor } from '@/components/layout/DatabaseHealthMonitor';
import { PinProvider } from '@/components/kiosk/PinProvider';
import { Toaster } from '@/components/kiosk/Toaster';
import { CarouselDots } from '@/components/ui/carousel-dots';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useHighContrast } from '@/hooks/useHighContrast';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';
import { canView } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { MqttProvider } from '@/mqtt/MqttProvider';
import { AdminPage } from '@/pages/AdminPage';
import { EnergyPage } from '@/pages/EnergyPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { RoomsPage } from '@/pages/RoomsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { UsersPage } from '@/pages/UsersPage';
import { useHomeStore, type ViewId } from '@/store/homeStore';

/**
 * Ordine naturale del carosello orizzontale. Le schermate non consentite al
 * profilo attivo vengono filtrate: lo swipe non porta mai a un AccessDenied.
 */
const SWIPE_PAGES: readonly ViewId[] = ['overview', 'rooms', 'energy', 'settings'];

function AccessDenied({ viewKey }: { viewKey: 'energy' | 'settings' | 'users' | 'admin' }) {
  const { t } = useTranslation();
  const setView = useHomeStore((state) => state.setView);
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-panel text-fg-subtle">
        <Lock className="size-5" />
      </span>
      <p className="text-sm font-medium text-fg">
        {t('accessDenied.title', { view: t(`accessDenied.views.${viewKey}`) })}
      </p>
      <p className="max-w-sm text-xs text-fg-subtle">{t('accessDenied.description')}</p>
      <button
        type="button"
        onClick={() => setView('overview')}
        className="mt-2 h-10 rounded-xl border border-line px-4 text-xs font-medium text-fg-muted hover:text-fg"
      >
        {t('accessDenied.back')}
      </button>
    </div>
  );
}

function CurrentView() {
  const view = useHomeStore((state) => state.ui.view);
  const user = useCurrentUser();

  if (view === 'energy' && user.restrictions.energy) {
    return <AccessDenied viewKey="energy" />;
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
          fallback={<AccessDenied viewKey="settings" />}
        >
          <SettingsPage />
        </RequireRole>
      );
    case 'users':
      return (
        <RequireRole
          roles={['admin', 'family']}
          allowElevated
          fallback={<AccessDenied viewKey="users" />}
        >
          <UsersPage />
        </RequireRole>
      );
    case 'admin':
      return (
        <RequireRole roles={['admin']} fallback={<AccessDenied viewKey="admin" />}>
          <AdminPage />
        </RequireRole>
      );
  }
}

/**
 * Shell autenticata: qui la sessione esiste, quindi `useCurrentUser` è lecito.
 * Lo swipe cambia pagina tramite lo store, mantenendo Sidebar e header in sync.
 */
function AppNavigation() {
  const { t } = useTranslation();
  const view = useHomeStore((state) => state.ui.view);
  const setView = useHomeStore((state) => state.setView);
  const user = useCurrentUser();
  const [enterFrom, setEnterFrom] = useState<'left' | 'right' | null>(null);

  const pages = useMemo(
    () => SWIPE_PAGES.filter((page) => canView(user, user.elevated, page)),
    [user],
  );
  const pageIds = useMemo(() => pages, [pages]);

  const swipe = useSwipeNavigation<ViewId>({
    items: pageIds,
    current: view,
    // In RoomsPage lo swipe appartiene al carosello delle stanze: qui è spento.
    enabled: view !== 'rooms',
    onChange: setView,
    onSwipe: (direction) => setEnterFrom(direction === 'left' ? 'right' : 'left'),
  });

  const viewAnimation =
    enterFrom === 'right'
      ? 'animate-slide-in-right'
      : enterFrom === 'left'
        ? 'animate-slide-in-left'
        : 'animate-rise';

  return (
    <>
      <AppShell
        mainProps={{
          ...swipe.handlers,
          // Il browser gestisce solo il pan verticale: i gesti orizzontali
          // arrivano al hook senza scroll laterale della pagina.
          style: { touchAction: 'pan-y' },
        }}
      >
        <div key={view} className={cn(viewAnimation, 'motion-reduce:animate-none')}>
          <CurrentView />
        </div>
      </AppShell>
      {pages.length > 1 && swipe.currentIndex >= 0 ? (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-2 z-20 flex justify-center"
          data-testid="page-swipe-dots"
        >
          <div className="rounded-full border border-line/70 bg-panel/85 px-2 py-1 shadow-lg shadow-black/20">
            <CarouselDots
              count={pages.length}
              activeIndex={swipe.currentIndex}
              label={t('swipe.page')}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function App() {
  // Il tema alto contrasto vive a livello applicazione: `data-contrast` su
  // <html> è già attivo sul lock screen, prima che l'utente faccia login.
  useHighContrast();

  return (
    <>
      {/* Health del database a livello applicazione: notifiche e badge anche
          sul lock screen, prima che la topologia sia caricata. */}
      <DatabaseHealthMonitor />
      <AuthGate>
        <TopologyGate>
          <PinProvider>
            <MqttProvider>
              <AppNavigation />
            </MqttProvider>
          </PinProvider>
        </TopologyGate>
      </AuthGate>
      <Toaster />
    </>
  );
}
