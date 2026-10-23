import { KeyRound, LogOut, MoonStar } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { roomLabel } from '@/lib/rooms';
import { ContrastToggle } from '@/components/settings/ContrastToggle';
import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAuthStore } from '@/store/authStore';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import { Clock } from './Clock';
import { ConnectionBadge } from './ConnectionBadge';
import { DatabaseBadge } from './DatabaseBadge';

export function Header({ onStandby }: { onStandby: () => void }) {
  const { t } = useTranslation();
  const view = useHomeStore((state) => state.ui.view);
  const room = useHomeStore((state) => state.ui.room);
  const rooms = useHomeStore((state) => state.rooms);
  const setView = useHomeStore((state) => state.setView);
  const logout = useAuthStore((state) => state.logout);
  const user = useCurrentUser();
  const requestPin = usePinGuard();
  const pushToast = useToastStore((state) => state.push);
  const title = t(`header.views.${view}.title`);

  const unlockPanel = () => {
    requestPin({
      title: t('header.unlock.dialogTitle'),
      description: t('header.unlock.dialogDescription'),
      action: t('header.unlock.dialogAction'),
      onConfirm: () => {
        pushToast({
          title: t('header.unlock.toastTitle'),
          description: t('header.unlock.toastDescription'),
          tone: 'success',
        });
      },
    });
  };
  const subtitle =
    view === 'rooms'
      ? t('header.roomSubtitle', { room: roomLabel(rooms, room) })
      : t(`header.views.${view}.subtitle`);

  return (
    <header className="flex h-20 shrink-0 items-center justify-between gap-3 border-b border-line bg-panel/40 px-4 lg:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold tracking-tight text-fg lg:text-lg">
          {title}
        </h1>
        <p className="mt-0.5 truncate text-[11px] text-fg-subtle">{subtitle}</p>
      </div>

      <div className="flex items-center gap-2 lg:gap-4">
        {user.role === 'kiosk' && !user.elevated ? (
          <button
            type="button"
            onClick={unlockPanel}
            className="flex h-11 items-center gap-2 rounded-2xl border border-warning/30 bg-warning/10 px-3 text-[11px] font-medium text-warning transition-colors hover:bg-warning/15"
            aria-label={t('header.unlock.aria')}
            title={t('header.unlock.title')}
          >
            <KeyRound className="size-4" />
            <span className="hidden lg:inline">{t('header.unlock.label')}</span>
          </button>
        ) : null}
        {/* Accesso rapido al tema alto contrasto: sempre visibile, anche sui
            pannelli piccoli dove gli altri badge sono nascosti. */}
        <ContrastToggle />
        <button
          type="button"
          onClick={onStandby}
          className="hidden size-11 items-center justify-center rounded-2xl border border-line text-fg-muted transition-colors hover:bg-panel-2 hover:text-fg sm:flex"
          aria-label={t('header.standby')}
          title={t('header.standby')}
        >
          <MoonStar className="size-4" />
        </button>
        <div className="hidden sm:block">
          <DatabaseBadge />
        </div>
        <div className="hidden sm:block">
          <ConnectionBadge onOpenSettings={() => setView('settings')} />
        </div>
        <Clock />
        <button
          type="button"
          onClick={() => void logout()}
          className="hidden size-11 items-center justify-center rounded-2xl border border-line text-fg-subtle transition-colors hover:bg-panel-2 hover:text-fg sm:flex"
          aria-label={t('header.logout')}
          title={t('header.logout')}
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </header>
  );
}
