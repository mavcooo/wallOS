import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Field, FormError, ToggleField, selectClass } from '@/components/admin/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, type DevicePayload } from '@/lib/adminApi';
import { roomIdFromLabel, type RoomConfig } from '@/lib/rooms';
import type { AdapterId, Device, DeviceKind } from '@/types/device';

const TYPES: readonly DeviceKind[] = ['light', 'climate', 'power', 'media', 'sensor'];

const ADAPTERS: readonly AdapterId[] = [
  'zigbee2mqtt',
  'shelly',
  'tasmota',
  'custom-json',
  'ha-discovery',
];

export function DeviceForm({
  device,
  rooms,
  onSaved,
  onCancel,
}: {
  device?: Device;
  rooms: readonly RoomConfig[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(device?.name ?? '');
  const [id, setId] = useState(device?.id ?? '');
  const [idTouched, setIdTouched] = useState(Boolean(device));
  const [roomId, setRoomId] = useState(device?.room ?? rooms[0]?.id ?? '');
  const [type, setType] = useState<DeviceKind>(device?.kind ?? 'light');
  const [adapter, setAdapter] = useState<AdapterId>(device?.adapter ?? 'zigbee2mqtt');
  const [model, setModel] = useState(device?.model ?? '');
  const [stateTopic, setStateTopic] = useState(device?.topics.state ?? '');
  const [commandTopic, setCommandTopic] = useState(device?.topics.command ?? '');
  const [availabilityTopic, setAvailabilityTopic] = useState(
    device?.topics.availability ?? '',
  );
  const [favorite, setFavorite] = useState(device?.favorite ?? false);
  const [protectedDevice, setProtectedDevice] = useState(device?.protected ?? false);
  const [displayOrder, setDisplayOrder] = useState(String(device?.displayOrder ?? 0));
  const [fieldMap, setFieldMap] = useState(
    device?.fieldMap ? JSON.stringify(device.fieldMap, null, 2) : '',
  );
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

    let parsedFieldMap: Record<string, string> | undefined;
    if (fieldMap.trim()) {
      try {
        const raw: unknown = JSON.parse(fieldMap);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error(t('forms.device.fieldMapObject'));
        }
        const entries = Object.entries(raw as Record<string, unknown>);
        if (entries.some(([, value]) => typeof value !== 'string')) {
          throw new Error(t('forms.device.fieldMapStrings'));
        }
        parsedFieldMap = Object.fromEntries(entries) as Record<string, string>;
      } catch (cause) {
        setError(
          t('forms.device.fieldMapInvalid', {
            reason: cause instanceof Error ? cause.message : 'JSON',
          }),
        );
        setBusy(false);
        return;
      }
    }

    try {
      const payload: DevicePayload = {
        roomId,
        name: name.trim(),
        type,
        adapter,
        model: model.trim() || null,
        stateTopic: stateTopic.trim(),
        commandTopic: commandTopic.trim() || null,
        availabilityTopic: availabilityTopic.trim() || null,
        favorite,
        protected: protectedDevice,
        displayOrder: Number(displayOrder) || 0,
        ...(parsedFieldMap ? { fieldMap: parsedFieldMap } : {}),
      };
      if (device) {
        await adminApi.updateDevice(device.id, payload);
      } else {
        await adminApi.createDevice({ ...payload, id: id.trim() || undefined });
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
            placeholder={t('forms.device.namePlaceholder')}
          />
        </Field>
        <Field
          label={t('forms.id')}
          hint={device ? t('forms.idLocked') : t('forms.idHint')}
        >
          <Input
            value={id}
            onChange={(event) => {
              setIdTouched(true);
              setId(event.target.value);
            }}
            disabled={Boolean(device)}
            required
            maxLength={64}
            pattern="[a-z0-9][a-z0-9:_-]*"
            placeholder="light-garage"
          />
        </Field>
        <Field label={t('forms.device.room')}>
          <select
            className={selectClass}
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            required
          >
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('forms.device.type')}>
          <select
            className={selectClass}
            value={type}
            onChange={(event) => setType(event.target.value as DeviceKind)}
          >
            {TYPES.map((item) => (
              <option key={item} value={item}>
                {t(`forms.device.types.${item}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('forms.device.adapter')}>
          <select
            className={selectClass}
            value={adapter}
            onChange={(event) => setAdapter(event.target.value as AdapterId)}
          >
            {ADAPTERS.map((item) => (
              <option key={item} value={item}>
                {t(`forms.device.adapters.${item}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('forms.device.model')} hint={t('forms.device.modelHint')}>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={80}
            placeholder="Ikea TRADFRI"
          />
        </Field>
        <Field label={t('forms.device.stateTopic')}>
          <Input
            value={stateTopic}
            onChange={(event) => setStateTopic(event.target.value)}
            required
            maxLength={512}
            placeholder="zigbee2mqtt/garage/light"
          />
        </Field>
        <Field label={t('forms.device.commandTopic')} hint={t('forms.device.commandHint')}>
          <Input
            value={commandTopic}
            onChange={(event) => setCommandTopic(event.target.value)}
            maxLength={512}
            placeholder="zigbee2mqtt/garage/light/set"
          />
        </Field>
        <Field
          label={t('forms.device.availabilityTopic')}
          hint={t('forms.device.availabilityHint')}
        >
          <Input
            value={availabilityTopic}
            onChange={(event) => setAvailabilityTopic(event.target.value)}
            maxLength={512}
            placeholder="zigbee2mqtt/garage/light/availability"
          />
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

      {adapter === 'custom-json' ? (
        <Field label={t('forms.device.fieldMap')} hint={t('forms.device.fieldMapHint')}>
          <textarea
            value={fieldMap}
            onChange={(event) => setFieldMap(event.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full rounded-xl border border-line bg-panel-2 px-3 py-2 font-mono text-[11px] text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
          />
        </Field>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ToggleField
          label={t('forms.device.favorite')}
          hint={t('forms.device.favoriteHint')}
          checked={favorite}
          onChange={setFavorite}
        />
        <ToggleField
          label={t('forms.device.protected')}
          hint={t('forms.device.protectedHint')}
          checked={protectedDevice}
          onChange={setProtectedDevice}
        />
      </div>

      <FormError message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('forms.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || name.trim().length === 0 || stateTopic.trim().length === 0}
        >
          {busy ? t('forms.saving') : t(device ? 'forms.device.save' : 'forms.device.create')}
        </Button>
      </div>
    </form>
  );
}
