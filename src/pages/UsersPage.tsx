import { Check, KeyRound, Lock, Pencil, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { roomLabel } from '@/lib/rooms';
import { usePinGuard } from '@/components/kiosk/PinProvider';
import { UserFormDialog } from '@/components/users/UserFormDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useRooms } from '@/hooks/useTopologyQuery';
import { useDeleteUser, useUpdateUser, useUsers } from '@/hooks/useUsers';
import { ROLE_TONE, restrictionsFor, type Restrictions } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import type { SessionUser } from '@/types/user';

function RestrictionChips({ restrictions }: { restrictions: Restrictions }) {
  const { t } = useTranslation('settings');
  const items = [
    restrictions.settings && t('users.restrictionsList.settings'),
    restrictions.energy && t('users.restrictionsList.energy'),
    restrictions.users && t('users.restrictionsList.users'),
    restrictions.sensitiveActions && t('users.restrictionsList.sensitiveActions'),
  ].filter((item): item is string => Boolean(item));

  if (items.length === 0) {
    return <span className="text-[10px] text-success">{t('users.fullAccess')}</span>;
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
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation();
  const current = useCurrentUser();
  const usersQuery = useUsers();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const users = usersQuery.data ?? [];
  const switchUser = useAuthStore((state) => state.switchUser);
  const temporary = useAuthStore((state) => state.temporary);
  const rooms = useRooms();
  const requestPin = usePinGuard();
  const pushToast = useToastStore((state) => state.push);

  const [form, setForm] = useState<{ user?: SessionUser } | null>(null);
  const [deleting, setDeleting] = useState<SessionUser | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!usersQuery.isError) return;
    pushToast({
      title: t('users.toasts.loadFailedTitle'),
      description: t('users.toasts.loadFailedDescription'),
      tone: 'error',
    });
  }, [usersQuery.isError, pushToast, t]);

  const canSwitch = current.role === 'admin' || (current.role === 'kiosk' && current.elevated);
  const canManage = current.role === 'admin';

  const roleLabel = (role: SessionUser['role']) => tCommon(`roles.${role}`);

  /**
   * Le operazioni che modificano account o topologia chiedono il PIN quando la
   * sessione non è già elevata: il dialog è unico (PinProvider) e la verifica
   * resta server-side.
   */
  const guard = (run: () => void) => {
    if (current.elevated) {
      run();
      return;
    }
    requestPin({
      title: t('users.pin.title'),
      description: t('users.pin.description'),
      action: t('users.pin.action'),
      onConfirm: run,
    });
  };

  const activateProfile = (user: SessionUser) => {
    if (user.id === current.id) return;
    if (!canSwitch) {
      pushToast({
        title: t('users.toasts.switchDeniedTitle'),
        description: t('users.toasts.switchDeniedDescription'),
        tone: 'error',
      });
      return;
    }

    requestPin({
      title: t('users.toasts.switchTitle'),
      description: t('users.toasts.switchDescription', {
        name: user.name,
        role: roleLabel(user.role),
      }),
      action: t('users.toasts.switchAction'),
      onConfirm: (pin) => {
        if (!pin) return;
        void switchUser(user.id, pin)
          .then(() => {
            pushToast({
              title: t('users.toasts.switchedTitle', { name: user.name }),
              description: t('users.toasts.switchedDescription', {
                role: roleLabel(user.role),
              }),
              tone: 'success',
            });
          })
          .catch((error: unknown) => {
            pushToast({
              title: t('users.toasts.switchFailedTitle'),
              description:
                error instanceof Error ? error.message : t('users.toasts.switchFailedDescription'),
              tone: 'error',
            });
          });
      },
    });
  };

  const toggleActive = (user: SessionUser, active: boolean) => {
    if (!canManage) return;
    updateUser.mutate(
      { id: user.id, input: { active } },
      {
        onSuccess: () => {
          pushToast({
            title: active
              ? t('users.toasts.activated', { name: user.name })
              : t('users.toasts.deactivated', { name: user.name }),
            tone: 'success',
          });
        },
        onError: (error) => {
          pushToast({
            title: t('users.toasts.updateFailedTitle'),
            description: error.message || t('users.toasts.updateFailedDescription'),
            tone: 'error',
          });
        },
      },
    );
  };

  const openDelete = (user: SessionUser) => {
    if (user.id === current.id) {
      pushToast({
        title: t('users.delete.selfTitle'),
        description: t('users.delete.selfDescription'),
        tone: 'error',
      });
      return;
    }
    guard(() => {
      setDeleteError(null);
      setDeleting(user);
    });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await deleteUser.mutateAsync(deleting.id);
      pushToast({
        title: t('users.delete.deleted', { name: deleting.name }),
        tone: 'success',
      });
      setDeleting(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('users.delete.failed'));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="flex flex-col justify-between rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
              {t('users.session')}
            </p>
            <p className="mt-2 text-lg font-medium text-fg">{current.name}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge variant={ROLE_TONE[current.role]}>{roleLabel(current.role)}</Badge>
              {current.elevated ? (
                <Badge variant="warning">{t('users.elevated')}</Badge>
              ) : null}
              {temporary ? <Badge variant="outline">{t('users.temporary')}</Badge> : null}
              <span className="text-[10px] text-fg-subtle">
                {current.allowedRooms
                  ? t('users.roomsAllowed', { count: current.allowedRooms.length })
                  : t('users.allRooms')}
              </span>
            </div>
          </div>
          <p className="mt-4 text-[10px] leading-relaxed text-fg-subtle">{t('users.sessionNote')}</p>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            {t('users.restrictions')}
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
                {t('users.allRooms')}
              </span>
            ) : null}
          </div>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            {t('users.security')}
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-[11px] text-fg-muted">
            <li className="flex items-center gap-2">
              <ShieldCheck className="size-3.5 text-success" />
              {t('users.securityItems.pin')}
            </li>
            <li className="flex items-center gap-2">
              <Lock className="size-3.5 text-accent" /> {t('users.securityItems.lockout')}
            </li>
            <li className="flex items-center gap-2">
              <KeyRound className="size-3.5 text-warning" /> {t('users.securityItems.token')}
            </li>
            <li className="flex items-center gap-2">
              <UserRound className="size-3.5 text-fg-subtle" /> {t('users.securityItems.roles')}
            </li>
          </ul>
        </div>
      </div>

      <section className="flex flex-col gap-2.5">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t('users.profiles')}</h2>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            {canSwitch ? t('users.profilesHint') : t('users.profilesReadOnly')}
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
                  <p className="text-[10px] text-fg-subtle">{roleLabel(user.role)}</p>
                </div>
              </button>
            );
          })}
          {users.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[11px] text-fg-subtle">
              {usersQuery.isLoading ? t('users.loading') : t('users.empty')}
            </p>
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">{t('users.listTitle')}</h2>
            <span className="text-[10px] text-fg-subtle">
              {t('users.listCount', { count: users.length })}
            </span>
          </div>
          {canManage ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => guard(() => setForm({}))}
            >
              <Plus className="size-4" /> {t('users.create')}
            </Button>
          ) : null}
        </div>
        <ul className="divide-y divide-line">
          {users.map((user) => {
            const self = user.id === current.id;
            return (
              <li
                key={user.id}
                className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-panel-2 text-[11px] font-semibold text-fg">
                    {user.initials}
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                      <span className="truncate">{user.name}</span>
                      <Badge variant={ROLE_TONE[user.role]} className="shrink-0">
                        {roleLabel(user.role)}
                      </Badge>
                      {user.isKioskDevice ? (
                        <Badge variant="outline" className="shrink-0">
                          {t('users.kioskBadge')}
                        </Badge>
                      ) : null}
                      <Badge variant="success" className="shrink-0">
                        {t('users.pinConfigured', { length: user.pinLength })}
                      </Badge>
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-fg-subtle">
                      @{user.username}
                      {' · '}
                      {user.allowedRooms === null
                        ? t('users.allRooms')
                        : user.allowedRooms.map((room) => roomLabel(rooms, room)).join(' · ')}
                      {' · '}
                      {user.lastAccess ?? t('users.neverAccess')}
                    </p>
                  </div>
                </div>

                <div className="hidden shrink-0 lg:block">
                  <RestrictionChips restrictions={restrictionsFor(user.role, false)} />
                </div>

                <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
                  <span className="text-[10px] text-fg-subtle">
                    {user.active ? t('users.active') : t('users.inactive')}
                  </span>
                  <Switch
                    checked={user.active}
                    onCheckedChange={(active) => toggleActive(user, active)}
                    disabled={!canManage || self || updateUser.isPending}
                    aria-label={t('users.toggleAria', { name: user.name })}
                  />
                  {canManage ? (
                    <div className="flex items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('users.editAria', { name: user.name })}
                        title={t('users.editAria', { name: user.name })}
                        onClick={() => guard(() => setForm({ user }))}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-danger hover:bg-danger/10 hover:text-danger"
                        disabled={self || deleteUser.isPending}
                        aria-label={t('users.deleteAria', { name: user.name })}
                        title={
                          self
                            ? t('users.delete.selfDescription')
                            : t('users.deleteAria', { name: user.name })
                        }
                        onClick={() => openDelete(user)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
        {t('users.note')}
      </p>

      <UserFormDialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        user={form?.user}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteUser.isPending) setDeleting(null);
        }}
      >
        {deleting ? (
          <DialogContent className="w-[min(92vw,26rem)]">
            <DialogHeader>
              <DialogTitle>{t('users.delete.title', { name: deleting.name })}</DialogTitle>
              <DialogDescription>{t('users.delete.description')}</DialogDescription>
            </DialogHeader>
            {deleteError ? (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
              >
                {deleteError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDeleting(null)}
                disabled={deleteUser.isPending}
              >
                {t('users.delete.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void confirmDelete()}
                disabled={deleteUser.isPending}
              >
                {deleteUser.isPending ? t('users.delete.busy') : t('users.delete.confirm')}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
