import { MoonStar } from 'lucide-react';

import { ROOM_LABELS } from '@/config/rooms.config';
import { useHomeStore, type ViewId } from '@/store/homeStore';
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
  const setView = useHomeStore((state) => state.setView);
  const meta = TITLES[view];
  const subtitle = view === 'rooms' ? `Ambiente · ${ROOM_LABELS[room]}` : meta.subtitle;

  return (
    <header className="flex h-20 shrink-0 items-center justify-between gap-3 border-b border-line bg-panel/40 px-4 lg:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold tracking-tight text-fg lg:text-lg">
          {meta.title}
        </h1>
        <p className="mt-0.5 truncate text-[11px] text-fg-subtle">{subtitle}</p>
      </div>

      <div className="flex items-center gap-2 lg:gap-4">
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
      </div>
    </header>
  );
}
