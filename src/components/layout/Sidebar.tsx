import { ChartNoAxesColumn, House, LayoutGrid, Settings, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ROLE_LABELS, canView } from '@/lib/permissions';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useHomeStore, type ViewId } from '@/store/homeStore';

interface NavItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
}

const NAV: readonly NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'rooms', label: 'Stanze', icon: House },
  { id: 'energy', label: 'Consumi', icon: ChartNoAxesColumn },
  { id: 'settings', label: 'Impostazioni', icon: Settings },
  { id: 'users', label: 'Utenti', icon: Users },
];

export function Sidebar() {
  const view = useHomeStore((state) => state.ui.view);
  const setView = useHomeStore((state) => state.setView);
  const user = useCurrentUser();

  return (
    <aside className="flex w-[84px] shrink-0 flex-col border-r border-line bg-panel/60 xl:w-[236px]">
      <div className="flex h-20 items-center gap-3 px-4 xl:px-5">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft text-accent">
          <House className="size-5" strokeWidth={2.2} />
        </div>
        <div className="hidden min-w-0 flex-col xl:flex">
          <span className="text-sm font-semibold tracking-[0.18em] text-fg">DOMUS</span>
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Local control</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1.5 px-2.5 py-4 xl:px-3" aria-label="Navigazione">
        {NAV.map((item) => {
          const disabled = !canView(user, user.elevated, item.id);
          const active = view === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => setView(item.id)}
              title={disabled ? `${item.label} non consentito per ${ROLE_LABELS[user.role]}` : item.label}
              className={cn(
                'group relative flex min-h-12 items-center justify-center gap-3 rounded-2xl px-3 text-sm font-medium transition-colors xl:justify-start xl:px-4',
                active
                  ? 'bg-elevated text-fg'
                  : 'text-fg-muted hover:bg-panel-2 hover:text-fg',
                disabled && 'cursor-not-allowed opacity-30 hover:bg-transparent',
              )}
              aria-current={active ? 'page' : undefined}
            >
              {active ? (
                <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-accent" />
              ) : null}
              <Icon className={cn('size-5 shrink-0', active && 'text-accent')} />
              <span className="hidden xl:inline">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-line p-2.5 xl:p-3">
        {/* Sempre raggiungibile: il cambio profilo è protetto da PIN e
            impedisce il lockout quando il profilo attivo non vede "Utenti". */}
        <button
          type="button"
          onClick={() => setView('users')}
          className="flex w-full items-center justify-center gap-3 rounded-2xl p-2 text-left transition-colors hover:bg-panel-2 xl:justify-start"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-panel-2 text-[11px] font-semibold text-fg">
            {user.initials}
          </span>
          <span className="hidden min-w-0 flex-col xl:flex">
            <span className="truncate text-xs font-medium text-fg">{user.name}</span>
            <span className="truncate text-[10px] text-fg-subtle">{ROLE_LABELS[user.role]}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}
