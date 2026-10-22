import { KeyRound, LogOut, MoonStar } from 'lucide-react';

import { roomLabel } from '@/config/rooms.config';
import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAuthStore } from '@/store/authStore';
import { useHomeStore, type ViewId } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import { Clock } from './Clock';
import { ConnectionBadge } from './ConnectionBadge';

const TITLES: Record<ViewId, { title: string; subtitle: string }> = {
  overview: { title: 'Overview', subtitle: 'Stato della casa in tempo reale' },
  rooms: { title: 'Stanze', subtitle: 'Controllo locale per ambiente' },
  energy: { title: 'Consumi', subtitle: 'Monitoraggio carichi e prelievo' },
  settings: { title: 'Impostazioni', subtitle: 'Broker, diagnostica e profilo kiosk' },
  users: { title: 'Utenti e profili', subtitle: 'Ruoli, stanze e azioni protette' },
};

export function Header({ onStandby }: { onStandby: () => void }) {
  const view = useHomeStore((state) => state.ui.view);
  const room = useHomeStore((state) => state.ui.room);
  const rooms = useHomeStore((state) => state.rooms);
  const setView = useHomeStore((state) => state.setView);
  const logout = useAuthStore((state) => state.logout);
  const user = useCurrentUser();
  const requestPin = usePinGuard();
  const pushToast = useToastStore((state) => state.push);
  const meta = TITLES[view];

  const unlockPanel = () => {
    requestPin({
      title: 'Sblocca pannello',
      description: 'Inserisci il PIN del dispositivo per accedere a impostazioni e profili.',
      action: 'L’elevazione dura 5 minuti.',
      onConfirm: () => {
        pushToast({
          title: 'Pannello sbloccato',
          description: 'Impostazioni e profili disponibili per 5 minuti.',
          tone: 'success',
        });
      },
    });
  };
  const subtitle = view === 'rooms' ? `Ambiente · ${roomLabel(rooms, room)}` : meta.subtitle;

  return (
    <header className="flex h-20 shrink-0 items-center justify-between gap-3 border-b border-line bg-panel/40 px-4 lg:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold tracking-tight text-fg lg:text-lg">
          {meta.title}
        </h1>
        <p className="mt-0.5 truncate text-[11px] text-fg-subtle">{subtitle}</p>
      </div>

      <div className="flex items-center gap-2 lg:gap-4">
        {user.role === 'kiosk' && !user.elevated ? (
          <button
            type="button"
            onClick={unlockPanel}
            className="flex h-11 items-center gap-2 rounded-2xl border border-warning/30 bg-warning/10 px-3 text-[11px] font-medium text-warning transition-colors hover:bg-warning/15"
            aria-label="Sblocca pannello con PIN"
            title="Sblocca impostazioni e profili con il PIN"
          >
            <KeyRound className="size-4" />
            <span className="hidden lg:inline">Sblocca</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={onStandby}
          className="hidden size-11 items-center justify-center rounded-2xl border border-line text-fg-muted transition-colors hover:bg-panel-2 hover:text-fg sm:flex"
          aria-label="Standby schermo"
          title="Standby schermo"
        >
          <MoonStar className="size-4" />
        </button>
        <div className="hidden sm:block">
          <ConnectionBadge onOpenSettings={() => setView('settings')} />
        </div>
        <Clock />
        <button
          type="button"
          onClick={() => void logout()}
          className="hidden size-11 items-center justify-center rounded-2xl border border-line text-fg-subtle transition-colors hover:bg-panel-2 hover:text-fg sm:flex"
          aria-label="Esci dalla sessione"
          title="Esci dalla sessione"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </header>
  );
}
