import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCreateUser, useUpdateUser } from '@/hooks/useUsers';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import type { SessionUser, UserRole } from '@/types/user';

const ROLES: readonly UserRole[] = ['admin', 'family', 'guest', 'kiosk'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

interface FormValues {
  username: string;
  displayName: string;
  role: UserRole;
  isKioskDevice: boolean;
  kioskDeviceId: string;
  pin: string;
  confirmPin: string;
  password: string;
  active: boolean;
}

function emptyValues(): FormValues {
  return {
    username: '',
    displayName: '',
    role: 'family',
    isKioskDevice: false,
    kioskDeviceId: '',
    pin: '',
    confirmPin: '',
    password: '',
    active: true,
  };
}

function valuesFrom(user: SessionUser): FormValues {
  return {
    username: user.username,
    displayName: user.name,
    role: user.role,
    isKioskDevice: user.isKioskDevice,
    kioskDeviceId: user.kioskDeviceId ?? '',
    pin: '',
    confirmPin: '',
    password: '',
    active: user.active,
  };
}

export function UserFormDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  user?: SessionUser | null;
}) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation();
  const pinPolicy = useAuthStore((state) => state.pinPolicy);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const pushToast = useToastStore((state) => state.push);
  const [values, setValues] = useState<FormValues>(emptyValues);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(user ? valuesFrom(user) : emptyValues());
    setError(null);
  }, [open, user]);

  const editing = Boolean(user);
  const busy = createUser.isPending || updateUser.isPending;

  const patch = (next: Partial<FormValues>) =>
    setValues((current) => ({ ...current, ...next }));

  const schema = z
    .object({
      username: z
        .string()
        .trim()
        .regex(USERNAME_RE, t('users.form.errors.username')),
      displayName: z.string().trim().max(80, t('users.form.errors.displayName')),
      role: z.enum(['admin', 'family', 'guest', 'kiosk']),
      isKioskDevice: z.boolean(),
      kioskDeviceId: z.string().trim(),
      pin: z.string(),
      confirmPin: z.string(),
      password: z.string(),
      active: z.boolean(),
    })
    .superRefine((data, context) => {
      if (data.isKioskDevice && data.role !== 'kiosk') {
        context.addIssue({
          code: 'custom',
          path: ['role'],
          message: t('users.form.errors.kioskRole'),
        });
      }
      if (data.isKioskDevice) {
        const deviceId = data.kioskDeviceId || data.username;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,63}$/.test(deviceId)) {
          context.addIssue({
            code: 'custom',
            path: ['kioskDeviceId'],
            message: t('users.form.errors.kioskDevice'),
          });
        }
      }
      if (!editing || data.pin.length > 0) {
        if (!/^\d+$/.test(data.pin)) {
          context.addIssue({
            code: 'custom',
            path: ['pin'],
            message: t('users.form.errors.pinDigits'),
          });
        } else if (
          data.pin.length < pinPolicy.minLength ||
          data.pin.length > pinPolicy.maxLength
        ) {
          context.addIssue({
            code: 'custom',
            path: ['pin'],
            message: t('users.form.errors.pinLength', {
              min: pinPolicy.minLength,
              max: pinPolicy.maxLength,
            }),
          });
        } else if (data.pin !== data.confirmPin) {
          context.addIssue({
            code: 'custom',
            path: ['confirmPin'],
            message: t('users.form.errors.pinMismatch'),
          });
        }
      }
      if ((!editing || data.password.length > 0) && !data.isKioskDevice) {
        if (data.password.length < 8) {
          context.addIssue({
            code: 'custom',
            path: ['password'],
            message: t('users.form.errors.password'),
          });
        }
      }
      // Un kiosk non ha password: convertirlo in un account normale richiede
      // una password, altrimenti il profilo resterebbe inaccessibile.
      if (editing && user?.isKioskDevice && !data.isKioskDevice && data.password.length < 8) {
        context.addIssue({
          code: 'custom',
          path: ['password'],
          message: t('users.form.errors.password'),
        });
      }
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('users.form.errors.invalid'));
      return;
    }

    const data = parsed.data;
    const base = {
      username: data.username,
      displayName: data.displayName || data.username,
      role: data.role,
      isKioskDevice: data.isKioskDevice,
      ...(data.isKioskDevice
        ? { kioskDeviceId: data.kioskDeviceId || data.username }
        : {}),
    };

    try {
      if (user) {
        const updated = await updateUser.mutateAsync({
          id: user.id,
          input: {
            ...base,
            active: data.active,
            ...(data.pin ? { pin: data.pin } : {}),
            ...(data.password ? { password: data.password } : {}),
          },
        });
        if (user.id === currentUserId) {
          // Il profilo corrente è cambiato: aggiorna lo store senza ruotare il
          // refresh (che una modifica password ha già revocato).
          useAuthStore.setState({ user: updated });
        }
        pushToast({ title: t('users.form.toasts.updated'), tone: 'success' });
      } else {
        await createUser.mutateAsync({
          ...base,
          pin: data.pin,
          ...(data.password ? { password: data.password } : {}),
        });
        pushToast({ title: t('users.form.toasts.created'), tone: 'success' });
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('users.form.errors.save'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!busy ? onOpenChange(next) : null)}>
      <DialogContent className="max-h-[92dvh] w-[min(94vw,34rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t(editing ? 'users.form.editTitle' : 'users.form.createTitle', {
              name: user?.name ?? '',
            })}
          </DialogTitle>
          <DialogDescription>{t('users.form.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-username">{t('users.form.username')}</Label>
              <Input
                id="user-username"
                value={values.username}
                onChange={(event) => patch({ username: event.target.value.toLowerCase() })}
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                placeholder="mario"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-display-name">{t('users.form.displayName')}</Label>
              <Input
                id="user-display-name"
                value={values.displayName}
                onChange={(event) => patch({ displayName: event.target.value })}
                maxLength={80}
                placeholder={t('users.form.displayNamePlaceholder')}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-role">{t('users.form.role')}</Label>
              <select
                id="user-role"
                value={values.role}
                disabled={Boolean(user && user.id === currentUserId)}
                onChange={(event) => {
                  const role = event.target.value as UserRole;
                  patch({ role, isKioskDevice: role === 'kiosk' });
                }}
                className="h-11 rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {tCommon(`roles.${role}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-kiosk-device">{t('users.form.kioskDeviceId')}</Label>
              <Input
                id="user-kiosk-device"
                value={values.kioskDeviceId}
                onChange={(event) => patch({ kioskDeviceId: event.target.value })}
                disabled={!values.isKioskDevice}
                maxLength={64}
                placeholder={values.username || 'wall-panel-1'}
                spellCheck={false}
              />
              <span className="text-[10px] leading-relaxed text-fg-subtle">
                {t('users.form.kioskDeviceHint')}
              </span>
            </div>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
            <div>
              <p className="text-xs font-medium text-fg">{t('users.form.kiosk')}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-fg-subtle">
                {t('users.form.kioskHint')}
              </p>
            </div>
            <Switch
              checked={values.isKioskDevice}
              disabled={Boolean(user && user.id === currentUserId)}
              onCheckedChange={(checked) =>
                patch({
                  isKioskDevice: checked,
                  role: checked ? 'kiosk' : values.role === 'kiosk' ? 'family' : values.role,
                })
              }
              aria-label={t('users.form.kiosk')}
            />
          </div>

          <div className="rounded-xl border border-line bg-panel-2/60 p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-fg">
              <KeyRound className="size-3.5 text-accent" /> {t('users.form.pinSection')}
            </p>
            <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="user-pin">
                  {editing ? t('users.form.pinNew') : t('users.form.pin')}
                </Label>
                <Input
                  id="user-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={pinPolicy.maxLength}
                  value={values.pin}
                  onChange={(event) =>
                    patch({ pin: event.target.value.replace(/\D/g, '') })
                  }
                  placeholder="••••"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="user-pin-confirm">{t('users.form.pinConfirm')}</Label>
                <Input
                  id="user-pin-confirm"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={pinPolicy.maxLength}
                  value={values.confirmPin}
                  onChange={(event) =>
                    patch({ confirmPin: event.target.value.replace(/\D/g, '') })
                  }
                  placeholder="••••"
                />
              </div>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-fg-subtle">
              {editing ? t('users.form.pinKeep') : t('users.form.pinHint')}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="user-password">
              {editing ? t('users.form.passwordNew') : t('users.form.password')}
            </Label>
            <Input
              id="user-password"
              type="password"
              autoComplete="new-password"
              value={values.password}
              onChange={(event) => patch({ password: event.target.value })}
              placeholder={values.isKioskDevice ? t('users.form.passwordOptional') : '••••••••'}
            />
            <span className="text-[10px] leading-relaxed text-fg-subtle">
              {editing ? t('users.form.passwordKeep') : t('users.form.passwordHint')}
            </span>
          </div>

          {editing ? (
            <div className="flex items-center justify-between rounded-xl border border-line bg-panel-2 px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-fg">{t('users.form.active')}</p>
                <p className="text-[10px] text-fg-subtle">{t('users.form.activeHint')}</p>
              </div>
              <Switch
                checked={values.active}
                onCheckedChange={(active) => patch({ active })}
                disabled={Boolean(user && user.id === currentUserId)}
                aria-label={t('users.form.active')}
              />
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
            >
              {error}
            </p>
          ) : null}

          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[10px] text-fg-subtle">
              <ShieldCheck className="size-3.5 text-success" />
              {t('users.form.securityNote')}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                {t('users.form.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy}
                className={cn(busy && 'opacity-70')}
              >
                {busy
                  ? t('users.form.saving')
                  : t(editing ? 'users.form.save' : 'users.form.create')}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
