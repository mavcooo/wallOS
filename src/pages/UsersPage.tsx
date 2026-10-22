import { Check, KeyRound, Lock, ShieldCheck, UserRound } from 'lucide-react';
import { useEffect } from 'react';

import { roomLabel } from '@/config/rooms.config';
import { usePinGuard } from '@/components/kiosk/PinProvider';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import {
  ROLE_LABELS,
  ROLE_TONE,
  restrictionsFor,
  type Restrictions,
} from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type { SessionUser } from '@/types/user';

function RestrictionChips({ restrictions }: { restrictions: Restrictions }) {
  const items = [
    restrictions.settings && 'no impostazioni',
    restrictions.energy && 'no consumi',
    restrictions.users && 'no utenti',
    restrictions.sensitiveActions && 'azioni con PIN',
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
  const current = useCurrentUser();
  const users = useAuthStore((state) => state.users);
  const loadUsers = useAuthStore((state) => state.loadUsers);
  const setUserActive = useAuthStore((state) => state.setUserActive);
  const switchUser = useAuthStore((state) => state.switchUser);
  const temporary = useAuthStore((state) => state.temporary);
  const rooms = useHomeStore((state) => state.rooms);
  const requestPin = usePinGuard();
  const pushToast = useToastStore((state) => state.push);

  useEffect(() => {
    void loadUsers().catch(() => {
      pushToast({
        title: 'Elenco profili non disponibile',
        description: 'Il gateway locale non ha risposto.',
        tone: 'error',
      });
    });
  }, [loadUsers, pushToast]);

  const canSwitch = current.role === 'admin' || (current.role === 'kiosk' && current.elevated);
  const canManage = current.role === 'admin';

  const activateProfile = (user: SessionUser) => {
    if (user.id === current.id) return;
    if (!canSwitch) {
      pushToast({
        title: 'Cambio profilo non consentito',
        description: 'Solo admin o kiosk elevato con PIN possono cambiare profilo.',
        tone: 'error',
      });
      return;
    }

    requestPin({
      title: 'Cambio profilo',
      description: `Stai passando al profilo ${user.name} (${ROLE_LABELS[user.role]}).`,
      action: 'La sessione temporanea scade senza revocare quella del dispositivo.',
      onConfirm: (pin) => {
        if (!pin) return;
        void switchUser(user.id, pin)
          .then(() => {
            pushToast({
              title: `Profilo ${user.name} attivo`,
              description: `${ROLE_LABELS[user.role]} · sessione temporanea`,
              tone: 'success',
            });
          })
          .catch((error: unknown) => {
            pushToast({
              title: 'Cambio profilo non riuscito',
              description:
                error instanceof Error ? error.message : 'Verifica PIN non riuscita.',
              tone: 'error',
            });
          });
      },
    });
  };

  const toggleActive = (user: SessionUser, active: boolean) => {
    if (!canManage) return;
    void setUserActive(user.id, active)
      .then(() => {
        pushToast({
          title: active ? `${user.name} attivato` : `${user.name} disattivato`,
          tone: 'success',
        });
      })
      .catch((error: unknown) => {
        pushToast({
          title: 'Aggiornamento non riuscito',
          description: error instanceof Error ? error.message : 'Operazione rifiutata.',
          tone: 'error',
        });
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="flex flex-col justify-between rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
              Sessione attiva
            </p>
            <p className="mt-2 text-lg font-medium text-fg">{current.name}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge variant={ROLE_TONE[current.role]}>{ROLE_LABELS[current.role]}</Badge>
              {current.elevated ? <Badge variant="warning">PIN elevato</Badge> : null}
              {temporary ? <Badge variant="outline">Temporaneo</Badge> : null}
              <span className="text-[10px] text-fg-subtle">
                {current.allowedRooms
                  ? `${current.allowedRooms.length} stanze abilitate`
                  : 'Tutte le stanze'}
              </span>
            </div>
          </div>
          <p className="mt-4 text-[10px] leading-relaxed text-fg-subtle">
            Il profilo arriva da /api/auth/me e non da un file compilato nel bundle. Il cambio
            profilo è verificato dal gateway e la sessione temporanea non sovrascrive il
            refresh kiosk.
          </p>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Restrizioni correnti
          </p>
          <div className="mt-3">
            <RestrictionChips restrictions={current.restrictions} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(current.allowedRooms ?? []).map((room) => (
              <span
                key={room}
                className="rounded-md border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-fg-muted"
              >
                {roomLabel(rooms, room)}
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
              <ShieldCheck className="size-3.5 text-success" /> PIN bcrypt solo nel database
            </li>
            <li className="flex items-center gap-2">
              <Lock className="size-3.5 text-accent" /> Lockout server-side dopo 3 errori
            </li>
            <li className="flex items-center gap-2">
              <KeyRound className="size-3.5 text-warning" /> JWT HttpOnly · refresh rotation
            </li>
            <li className="flex items-center gap-2">
              <UserRound className="size-3.5 text-fg-subtle" /> Ruoli applicati a viste e API
            </li>
          </ul>
        </div>
      </div>

      <section className="flex flex-col gap-2.5">
        <div>
          <h2 className="text-sm font-semibold text-fg">Profili</h2>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            {canSwitch
              ? 'Seleziona il profilo da usare su questo dispositivo (richiede PIN)'
              : 'Solo un amministratore o un kiosk elevato può cambiare profilo'}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          {users.map((user) => {
            const active = user.id === current.id;
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => activateProfile(user)}
                disabled={!canSwitch && !active}
                className={cn(
                  'flex flex-col items-start gap-2 rounded-2xl border p-3 text-left transition-colors',
                  active
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-line bg-panel hover:border-line-strong hover:bg-panel-2',
                  !canSwitch && !active && 'cursor-not-allowed opacity-50',
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
          {users.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[11px] text-fg-subtle">
              Caricamento profili dal gateway…
            </p>
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">Utenti locali</h2>
          <span className="text-[10px] text-fg-subtle">
            {users.length} profili nel database
          </span>
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
                      : user.allowedRooms.map((room) => roomLabel(rooms, room)).join(' · ')}
                    {' · '}
                    {user.lastAccess ?? 'mai'}
                  </p>
                </div>
              </div>

              <div className="hidden shrink-0 lg:block">
                <RestrictionChips restrictions={restrictionsFor(user.role, false)} />
              </div>

              <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                <span className="text-[10px] text-fg-subtle">
                  {user.active ? 'Attivo' : 'Disattivato'}
                </span>
                <Switch
                  checked={user.active}
                  onCheckedChange={(active) => toggleActive(user, active)}
                  disabled={!canManage || user.id === current.id}
                  aria-label={`Attiva o disattiva ${user.name}`}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p className="rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
        Nota architetturale: ruoli e permessi sono verificati dal micro-servizio auth e
        applicati alle API. Le restrizioni mostrate qui servono solo a nascondere o
        disabilitare controlli: un client browser non è un confine di sicurezza.
      </p>
    </div>
  );
}
