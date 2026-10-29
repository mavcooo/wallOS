import { QueryClientProvider } from '@tanstack/react-query';
import { Loader2, Lock } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthGate } from '@/components/auth/AuthGate';
import { QuerySessionBoundary } from '@/components/auth/QuerySessionBoundary';
import { RequireRole } from '@/components/auth/RequireRole';
import { TopologyGate } from '@/components/auth/TopologyGate';
import { AppShell } from '@/components/layout/AppShell';
import { DatabaseHealthMonitor } from '@/components/layout/DatabaseHealthMonitor';
import { EmergencyReloadModal } from '@/components/kiosk/EmergencyReloadModal';
import { PinProvider } from '@/components/kiosk/PinProvider';
import { Toaster } from '@/components/kiosk/Toaster';
import { CarouselDots } from '@/components/ui/carousel-dots';
import { CriticalAlertOverlay } from '@/components/ui/CriticalAlertOverlay';
import { useBootRecovery } from '@/hooks/useBootRecovery';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDeviceHealth } from '@/hooks/useDeviceHealth';
import { useKioskBootstrap } from '@/hooks/useKioskBootstrap';
import { useKioskSync } from '@/hooks/useKioskSync';
import { useKioskTelemetry } from '@/hooks/useKioskTelemetry';
import { useHighContrast } from '@/hooks/useHighContrast';
import { usePerformanceMode } from '@/hooks/usePerformanceMode';
import { useScreenWakeLock } from '@/hooks/useScreenWakeLock';
import { useSecuritySync } from '@/hooks/useSecuritySync';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';
import { useTopologySync } from '@/hooks/useTopologySync';
import { canView } from '@/lib/permissions';
import { createQueryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { MqttProvider } from '@/mqtt/MqttProvider';
import { useHomeStore, type ViewId } from '@/store/homeStore';

/**
 * Le viste sono chunk separati: l'avvio carica solo la pagina corrente, non
 * amministrazione, utenti, impostazioni e i loro form. Il service worker le
 * precarica comunque in background, quindi la navigazione successiva è locale.
 */
const OverviewPage = lazy(() =>
  import('@/pages/OverviewPage').then((module) => ({ default: module.OverviewPage })),
);
const RoomsPage = lazy(() =>
  import('@/pages/RoomsPage').then((module) => ({ default: module.RoomsPage })),
);
const EnergyPage = lazy(() =>
  import('@/pages/EnergyPage').then((module) => ({ default: module.EnergyPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const UsersPage = lazy(() =>
  import('@/pages/UsersPage').then((module) => ({ default: module.UsersPage })),
);
const AdminPage = lazy(() =>
  import('@/pages/AdminPage').then((module) => ({ default: module.AdminPage })),
);

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

function PageLoading() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[45vh] flex-col items-center justify-center gap-3 text-fg-subtle"
    >
      <Loader2 className="size-5 animate-spin text-accent" aria-hidden />
      <p className="text-[11px] uppercase tracking-wider">{t('gate.pageLoading')}</p>
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
        <Suspense fallback={<PageLoading />}>
          <div key={view} className={cn(viewAnimation, 'motion-reduce:animate-none')}>
            <CurrentView />
          </div>
        </Suspense>
      </AppShell>
      {pages.length > 1 && swipe.currentIndex >= 0 ? (
        // Su mobile i puntini stanno sopra la Bottom Navigation (64px + area
        // sicura): a `bottom-2` finirebbero sopra le etichette dei tab.
        <div
          className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] z-20 flex justify-center md:bottom-2"
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

/**
 * Sincronizzazione topologia multi-client a livello root: ascolta l'evento
 * `wallos/system/topology_changed` pubblicato dal server a ogni commit su
 * PostgreSQL e invalida la cache TanStack Query con debounce, così ogni tablet
 * della casa si riallinea in meno di un secondo senza tocco né reload.
 * Deve stare dentro <MqttProvider> perché riallinea anche le sottoscrizioni
 * ai topic dei device appena creati.
 */
function TopologySync() {
  useTopologySync();
  return null;
}

/**
 * Allarmi: legge `/api/security/state` e ascolta lo stream SSE, scrivendo lo
 * snapshot nello store che alimenta overlay e risveglio del dimmer. Vive fuori
 * da `AuthGate` perché il lock screen deve poter mostrare un allarme pendente
 * scattato mentre il pannello era spento; con sessione assente il hook si
 * limita a non interrogare il server.
 */
function SecuritySync() {
  useSecuritySync();
  return null;
}

/**
 * Profilo del display: idratazione da PostgreSQL all'avvio (`/api/kiosk/:id`) e
 * applicazione a caldo delle modifiche fatte dall'amministratore, che arrivano
 * su `wallos/system/kiosk/<id>/config_updated`. Vive accanto a `TopologySync`
 * perché usa gli stessi store e la stessa cache TanStack Query.
 */
function KioskProfile() {
  useKioskBootstrap();
  useKioskSync();
  return null;
}

/**
 * Battery Guardian e salute del dispositivo.
 *
 * Montato a livello root perché deve girare **sempre**, non solo mentre
 * Impostazioni è aperta: la telemetria batteria fa staccare la presa smart
 * all'80% (e la riattiva al 20%) anche a pannello in standby, e il watchdog di
 * heap/frame rate serve proprio durante le settimane di esecuzione continua in
 * cui nessuno guarda la diagnostica.
 */
function KioskDeviceHealth() {
  useDeviceHealth();
  useKioskTelemetry();
  return null;
}

export default function App() {
  // Il tema alto contrasto vive a livello applicazione: `data-contrast` su
  // <html> è già attivo sul lock screen, prima che l'utente faccia login.
  useHighContrast();
  // Modalità a basse prestazioni: l'attributo su <html> è già impostato dallo
  // script inline in index.html; il hook lo mantiene allineato allo store.
  usePerformanceMode();
  // Safe Boot: scarta i comandi pre-blackout e gestisce la finestra di
  // idratazione dopo un riavvio (UI bloccata, coda in pausa). Vive qui perché
  // deve partire prima di qualsiasi connessione MQTT.
  useBootRecovery();
  // Wake Lock a livello root: impedisce lo standby hardware dello schermo H24 e
  // riacquisisce il sentinel al ritorno in `visible`. Non tocca il dimmer
  // software (KioskDimmerOverlay), che resta l'unico gestore dello spegnimento
  // visivo; se il browser non supporta l'API l'hook è un no-op.
  useScreenWakeLock();
  // Un client per albero React: in StrictMode l'initializer viene scartato al
  // doppio render di sviluppo, senza condividere cache tra test o mount.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Cache della topologia legata alla sessione: cambio profilo → refetch,
          logout → query eliminata. */}
      <QuerySessionBoundary />
      {/* Il PIN è condiviso da azioni protette e riconoscimento allarmi, anche
          sul lock screen: il provider avvolge l'intera applicazione. */}
      <PinProvider>
        {/* Allarmi persistiti: overlay e risveglio del kiosk leggono questo
            store, non i toast effimeri della socket del browser. */}
        <SecuritySync />
        {/* Health del database a livello applicazione: notifiche e badge anche
            sul lock screen, prima che la topologia sia caricata. */}
        <DatabaseHealthMonitor />
        <AuthGate>
          <TopologyGate>
            <MqttProvider>
              <TopologySync />
              <KioskProfile />
              <KioskDeviceHealth />
              <AppNavigation />
            </MqttProvider>
          </TopologyGate>
        </AuthGate>
        <Toaster />
        {/* Allarmi critici: sopra il dimmer kiosk e il lock screen. */}
        <CriticalAlertOverlay />
        {/* Blackout di rete prolungato: countdown prima del riavvio applicazione. */}
        <EmergencyReloadModal />
      </PinProvider>
    </QueryClientProvider>
  );
}
