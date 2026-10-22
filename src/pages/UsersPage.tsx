import { Check, Lock, ShieldCheck, UserRound } from 'lucide-react';

import { ROLE_LABELS, type LocalUser } from '@/config/users.config';
import { ROOM_LABELS } from '@/config/rooms.config';
import { usePinGuard } from '@/components/kiosk/PinProvider';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';

const ROLE_TONE = {
  admin: 'accent',
  panel: 'success',
  standard: 'neutral',
  guest: 'warning',
} as const;

function RestrictionChips({ user }: { user: LocalUser }) {
  const items = [
    user.restrictions.settings && 'no impostazioni',
    user.restrictions.energy && 'no consumi',
    user.restrictions.users && 'no utenti',
    user.restrictions.sensitiveActions && 'azioni con PIN',
  ].filter((item): item is string => Boolean(item));

  if (items.length === 0) {
    return <span className="text-[10px] text-success">Accesso completo</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item}
          className="rounded-full border border-line bg-panel-2 px-1.5 py-0.5 text-[9px] text-fg-subtle"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

export function UsersPage() {
  const users = useHomeStore((state) => state.users);
  const activeUserId = useHomeStore((state) => state.ui.activeUserId);
  const setActiveUser = useHomeStore((state) => state.setActiveUser);
  const updateUser = useHomeStore((state) => state.updateUser);
  const current = useCurrentUser();
  const requestPin = usePinGuard();
  const pushToast = useToastStore((state) => state.push);

  const activateProfile = (user: LocalUser) => {
    if (user.id === activeUserId) return;
    requestPin({
      title: 'Cambio profilo',
      description: `Stai passando al profilo ${user.name} (${ROLE_LABELS[user.role]}).`,
      action: 'Le restrizioni del pannello cambieranno immediatamente.',
      onConfirm: () => {
        setActiveUser(user.id);
        updateUser(user.id, { lastAccess: 'Sessione attiva' });
        pushToast({
          title: `Profilo ${user.name} attivo`,
          description: ROLE_LABELS[user.role],
          tone: 'success',
        });
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="flex flex-col justify-between rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
              Profilo kiosk attivo
            </p>
            <p className="mt-2 text-lg font-medium text-fg">{current.name}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge variant={ROLE_TONE[current.role]}>{ROLE_LABELS[current.role]}</Badge>
              <span className="text-[10px] text-fg-subtle">
                {current.allowedRooms
                  ? `${current.allowedRooms.length} stanze abilitate`
                  : 'Tutte le stanze'}
              </span>
            </div>
          </div>
          <p className="mt-4 text-[10px] leading-relaxed text-fg-subtle">
            Il cambio profilo è protetto da PIN: il pannello a parete non deve poter diventare
            amministratore con un tocco accidentale.
          </p>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Restrizioni correnti
          </p>
          <div className="mt-3">
            <RestrictionChips user={current} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(current.allowedRooms ?? []).map((room) => (
              <span
                key={room}
                className="rounded-md border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-fg-muted"
              >
                {ROOM_LABELS[room]}
              </span>
            ))}
            {current.allowedRooms === null ? (
              <span className="rounded-md border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-fg-muted">
                Tutte le stanze
              </span>
            ) : null}
          </div>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Sicurezza locale
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-[11px] text-fg-muted">
            <li className="flex items-center gap-2">
              <ShieldCheck className="size-3.5 text-success" /> PIN hash SHA-256 sul dispositivo
            </li>
            <li className="flex items-center gap-2">
              <Lock className="size-3.5 text-accent" /> Blocco 60s dopo 3 tentativi errati
            </li>
            <li className="flex items-center gap-2">
              <UserRound className="size-3.5 text-fg-subtle" /> Ruoli applicati a viste e stanze
            </li>
          </ul>
        </div>
      </div>

      <section className="flex flex-col gap-2.5">
        <div>
          <h2 className="text-sm font-semibold text-fg">Profili pannello</h2>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            Seleziona il profilo da usare su questo dispositivo
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          {users.map((user) => {
            const active = user.id === activeUserId;
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => activateProfile(user)}
                className={cn(
                  'flex flex-col items-start gap-2 rounded-2xl border p-3 text-left transition-colors',
                  active
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-line bg-panel hover:border-line-strong hover:bg-panel-2',
                )}
              >
                <div className="flex w-full items-start justify-between">
                  <span
                    className={cn(
                      'flex size-10 items-center justify-center rounded-full border text-[11px] font-semibold',
                      active
                        ? 'border-accent/40 bg-accent text-accent-fg'
                        : 'border-line bg-panel-2 text-fg',
                    )}
                  >
                    {user.initials}
                  </span>
                  {active ? <Check className="size-4 text-accent" /> : null}
                </div>
                <div className="w-full">
                  <p className="truncate text-sm font-medium text-fg">{user.name}</p>
                  <p className="text-[10px] text-fg-subtle">{ROLE_LABELS[user.role]}</p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">Utenti locali</h2>
          <span className="text-[10px] text-fg-subtle">{users.length} profili memorizzati</span>
        </div>
        <ul className="divide-y divide-line">
          {users.map((user) => (
            <li
              key={user.id}
              className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-panel-2 text-[11px] font-semibold text-fg">
                  {user.initials}
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-fg">
                    {user.name}
                    <Badge variant={ROLE_TONE[user.role]} className="shrink-0">
                      {ROLE_LABELS[user.role]}
                    </Badge>
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-fg-subtle">
                    {user.allowedRooms === null
                      ? 'Tutte le stanze'
                      : user.allowedRooms.map((room) => ROOM_LABELS[room]).join(' · ')}
                    {' · '}
                    {user.lastAccess ?? 'mai'}
                  </p>
                </div>
              </div>

              <div className="hidden shrink-0 lg:block">
                <RestrictionChips user={user} />
              </div>

              <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                <span className="text-[10px] text-fg-subtle">
                  {user.active ? 'Attivo' : 'Disattivato'}
                </span>
                <Switch
                  checked={user.active}
                  onCheckedChange={(active) => updateUser(user.id, { active })}
                  aria-label={`Attiva o disattiva ${user.name}`}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p className="rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
        Nota architetturale: questi profili valgono per il pannello locale. La vera
        autorizzazione va applicata sul gateway (ACL MQTT per topic + verifica PIN lato
        server), perché un client browser non è un confine di sicurezza.
      </p>
    </div>
  );
}
