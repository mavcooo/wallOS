import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { useCreateRoom, useUpdateRoom } from '@/hooks/useTopologyMutations';
import type { RoomConfig } from '@/lib/rooms';
import { useToastStore } from '@/store/toastStore';

interface Values {
  name: string;
  shortLabel: string;
  icon: string;
  displayOrder: string;
}

function valuesFrom(room?: RoomConfig | null): Values {
  return {
    name: room?.label ?? '',
    shortLabel: room?.shortLabel && room.shortLabel !== room.label ? room.shortLabel : '',
    icon: room?.icon ?? 'home',
    displayOrder: String(room?.displayOrder ?? 0),
  };
}

export function RoomFormDialog({
  open,
  onOpenChange,
  room,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  room?: RoomConfig | null;
}) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation();
  const createRoom = useCreateRoom();
  const updateRoom = useUpdateRoom();
  const pushToast = useToastStore((state) => state.push);
  const [values, setValues] = useState<Values>(() => valuesFrom(room));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(valuesFrom(room));
    setError(null);
  }, [open, room]);

  const busy = createRoom.isPending || updateRoom.isPending;
  const editing = Boolean(room);

  const schema = z.object({
    name: z.string().trim().min(1, t('topology.roomDialog.errors.name')).max(80),
    shortLabel: z.string().trim().max(24),
    icon: z.string().trim().max(40),
    displayOrder: z.string(),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('topology.roomDialog.errors.invalid'));
      return;
    }
    const data = parsed.data;
    const order = Number(data.displayOrder);
    if (!Number.isInteger(order) || order < 0 || order > 9_999) {
      setError(t('topology.roomDialog.errors.order'));
      return;
    }

    try {
      const payload = {
        name: data.name,
        shortLabel: data.shortLabel || null,
        icon: data.icon || 'home',
        displayOrder: order,
      };
      if (room) {
        await updateRoom.mutateAsync({ id: room.id, payload });
        pushToast({ title: t('topology.roomDialog.toasts.updated'), tone: 'success' });
      } else {
        await createRoom.mutateAsync(payload);
        pushToast({ title: t('topology.roomDialog.toasts.created'), tone: 'success' });
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tCommon('forms.saveFailed'));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[92dvh] w-[min(94vw,32rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t(editing ? 'topology.roomDialog.editTitle' : 'topology.roomDialog.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('topology.roomDialog.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="room-name">{tCommon('forms.name')}</Label>
            <Input
              id="room-name"
              value={values.name}
              onChange={(event) =>
                setValues((current) => ({ ...current, name: event.target.value }))
              }
              maxLength={80}
              required
              placeholder={t('topology.roomDialog.namePlaceholder')}
            />
            <span className="text-[10px] text-fg-subtle">
              {editing ? tCommon('forms.idLocked') : t('topology.roomDialog.idHint')}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="room-short">{tCommon('forms.shortLabel')}</Label>
              <Input
                id="room-short"
                value={values.shortLabel}
                onChange={(event) =>
                  setValues((current) => ({ ...current, shortLabel: event.target.value }))
                }
                maxLength={24}
                placeholder={tCommon('forms.shortLabel')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="room-icon">{tCommon('forms.icon')}</Label>
              <Input
                id="room-icon"
                value={values.icon}
                onChange={(event) =>
                  setValues((current) => ({ ...current, icon: event.target.value }))
                }
                maxLength={40}
                placeholder="sofa"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="room-order">{tCommon('forms.order')}</Label>
              <Input
                id="room-order"
                type="number"
                min={0}
                max={9999}
                value={values.displayOrder}
                onChange={(event) =>
                  setValues((current) => ({ ...current, displayOrder: event.target.value }))
                }
              />
            </div>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
            >
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {tCommon('forms.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy
                ? tCommon('forms.saving')
                : t(editing ? 'topology.roomDialog.save' : 'topology.roomDialog.create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
