import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Field, FormError } from '@/components/admin/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, type RoomPayload } from '@/lib/adminApi';
import { roomIdFromLabel, type RoomConfig } from '@/lib/rooms';

const ICONS = ['home', 'sofa', 'cooking-pot', 'bed-double', 'laptop', 'bath', 'trees', 'car', 'inbox'];

export function RoomForm({
  room,
  onSaved,
  onCancel,
}: {
  room?: RoomConfig;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(room?.label ?? '');
  const [id, setId] = useState(room?.id ?? '');
  const [idTouched, setIdTouched] = useState(Boolean(room));
  const [shortLabel, setShortLabel] = useState(room?.shortLabel ?? '');
  const [icon, setIcon] = useState(room?.icon ?? 'home');
  const [displayOrder, setDisplayOrder] = useState(String(room?.displayOrder ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changeName = (value: string) => {
    setName(value);
    if (!idTouched) setId(roomIdFromLabel(value));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: RoomPayload = {
        name: name.trim(),
        shortLabel: shortLabel.trim() || null,
        icon: icon.trim() || 'home',
        displayOrder: Number(displayOrder) || 0,
      };
      if (room) {
        await adminApi.updateRoom(room.id, payload);
      } else {
        await adminApi.createRoom({ ...payload, id: id.trim() || undefined });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('forms.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('forms.name')}>
          <Input
            value={name}
            onChange={(event) => changeName(event.target.value)}
            required
            maxLength={80}
            placeholder="Garage"
          />
        </Field>
        <Field
          label={t('forms.id')}
          hint={room ? t('forms.idLocked') : t('forms.idHint')}
        >
          <Input
            value={id}
            onChange={(event) => {
              setIdTouched(true);
              setId(event.target.value);
            }}
            disabled={Boolean(room)}
            required
            maxLength={64}
            pattern="[a-z0-9][a-z0-9:_-]*"
            placeholder="garage"
          />
        </Field>
        <Field label={t('forms.shortLabel')} hint={t('forms.shortLabelHint')}>
          <Input
            value={shortLabel}
            onChange={(event) => setShortLabel(event.target.value)}
            maxLength={24}
            placeholder="Garage"
          />
        </Field>
        <Field label={t('forms.icon')} hint={t('forms.iconHint')}>
          <Input
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            list="room-icons"
            maxLength={40}
            placeholder="home"
          />
          <datalist id="room-icons">
            {ICONS.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </Field>
        <Field label={t('forms.order')} hint={t('forms.orderHint')}>
          <Input
            type="number"
            min={0}
            max={9999}
            value={displayOrder}
            onChange={(event) => setDisplayOrder(event.target.value)}
          />
        </Field>
      </div>

      <FormError message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('forms.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
          {busy ? t('forms.saving') : t(room ? 'forms.room.save' : 'forms.room.create')}
        </Button>
      </div>
    </form>
  );
}
