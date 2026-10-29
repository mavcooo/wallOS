import { useTranslation } from 'react-i18next';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { canView } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import { NAV_ITEMS } from './Sidebar';

/**
 * Navigazione per smartphone e tablet verticali (< 768px).
 *
 * Su un viewport da 390px una rail laterale da 84px resta il 21% della
 * larghezza e lascia le card in una colonna da ~250px: qui la navigazione si
 * sposta in basso e tutta la larghezza torna al contenuto. Le voci sono le
 * stesse della Sidebar (`NAV_ITEMS`), filtrate con `canView`, con target
 * minimo 48×48 e area sicura iOS rispettata.
 *
 * `md:hidden` è la seconda barriera: la shell non monta questo componente sopra
 * i 768px, e anche un cambio di viewport senza re-render non lo mostrerebbe.
 */
export function BottomNav({ className }: { className?: string }) {
  const { t } = useTranslation();
  const view = useHomeStore((state) => state.ui.view);
  const setView = useHomeStore((state) => state.setView);
  const user = useCurrentUser();
  const roleLabel = t(`roles.${user.role}`);

  return (
    <nav
      data-testid="bottom-nav"
      aria-label={t('nav.label')}
      className={cn(
        'safe-area-pb flex min-h-16 shrink-0 items-stretch justify-around gap-1 border-t border-line bg-panel/95 px-1 md:hidden',
        className,
      )}
    >
      {NAV_ITEMS.map((item) => {
        const disabled = !canView(user, user.elevated, item.id);
        const active = view === item.id;
        const Icon = item.icon;
        const label = t(`nav.${item.id}`);
        // Etichetta corta per la barra: "Impostazioni" su un tab da 60px si
        // troncherebbe a metà parola. L'`aria-label` resta quello completo.
        const shortLabel = t(`nav.short.${item.id}`);
        return (
          <button
            key={item.id}
            type="button"
            disabled={disabled}
            onClick={() => setView(item.id)}
            aria-current={active ? 'page' : undefined}
            aria-label={label}
            title={disabled ? t('nav.denied', { label, role: roleLabel }) : label}
            className={cn(
              // `min-h-12 min-w-12`: target touch da 48px anche con 6 voci su
              // uno schermo da 360px, dove il flex-1 scende sotto i 60px.
              'flex min-h-12 min-w-12 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1 text-[10px] font-medium transition-colors',
              active ? 'text-accent' : 'text-fg-muted active:bg-panel-2',
              disabled && 'cursor-not-allowed opacity-30',
            )}
          >
            <Icon className="size-5 shrink-0" aria-hidden />
            <span className="w-full truncate text-center">{shortLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}
