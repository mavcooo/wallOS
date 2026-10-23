import { useState, type FormEvent } from 'react';

import { Field, FormError, ToggleField, selectClass } from '@/components/admin/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, type DevicePayload } from '@/lib/adminApi';
import { roomIdFromLabel, type RoomConfig } from '@/lib/rooms';
import type { AdapterId, Device, DeviceKind } from '@/types/device';

const TYPES: { value: DeviceKind; label: string }[] = [
  { value: 'light', label: 'Luce' },
  { value: 'climate', label: 'Clima' },
  { value: 'power', label: 'Presa / energia' },
  { value: 'media', label: 'Media' },
  { value: 'sensor', label: 'Sensore' },
];

const ADAPTERS: { value: AdapterId; label: string }[] = [
  { value: 'zigbee2mqtt', label: 'Zigbee2MQTT' },
  { value: 'shelly', label: 'Shelly Gen2' },
  { value: 'tasmota', label: 'Tasmota' },
  { value: 'custom-json', label: 'JSON custom' },
  { value: 'ha-discovery', label: 'Home Assistant Discovery' },
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
          throw new Error('deve essere un oggetto');
        }
        const entries = Object.entries(raw as Record<string, unknown>);
        if (entries.some(([, value]) => typeof value !== 'string')) {
          throw new Error('i valori devono essere stringhe');
        }
        parsedFieldMap = Object.fromEntries(entries) as Record<string, string>;
      } catch (cause) {
        setError(`fieldMap non valido: ${cause instanceof Error ? cause.message : 'JSON'}`);
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
      setError(cause instanceof Error ? cause.message : 'Salvataggio non riuscito');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <Input
            value={name}
            onChange={(event) => changeName(event.target.value)}
            required
            maxLength={80}
            placeholder="Luce garage"
          />
        </Field>
        <Field
          label="ID (slug)"
          hint={device ? 'Chiave stabile: non modificabile' : 'Usato in topic e scenari'}
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
        <Field label="Stanza">
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
        <Field label="Tipo">
          <select
            className={selectClass}
            value={type}
            onChange={(event) => setType(event.target.value as DeviceKind)}
          >
            {TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Adapter">
          <select
            className={selectClass}
            value={adapter}
            onChange={(event) => setAdapter(event.target.value as AdapterId)}
          >
            {ADAPTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Modello" hint="Solo descrittivo">
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={80}
            placeholder="Ikea TRADFRI"
          />
        </Field>
        <Field label="Topic di stato">
          <Input
            value={stateTopic}
            onChange={(event) => setStateTopic(event.target.value)}
            required
            maxLength={512}
            placeholder="zigbee2mqtt/garage/light"
          />
        </Field>
        <Field label="Topic di comando" hint="Vuoto per i sensori read-only">
          <Input
            value={commandTopic}
            onChange={(event) => setCommandTopic(event.target.value)}
            maxLength={512}
            placeholder="zigbee2mqtt/garage/light/set"
          />
        </Field>
        <Field label="Topic availability" hint="LWT online/offline (opzionale)">
          <Input
            value={availabilityTopic}
            onChange={(event) => setAvailabilityTopic(event.target.value)}
            maxLength={512}
            placeholder="zigbee2mqtt/garage/light/availability"
          />
        </Field>
        <Field label="Ordine" hint="Numeri più bassi compaiono prima">
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
        <Field
          label="fieldMap (JSON)"
          hint='Es. {"on":"state.power","brightness":"state.dimmer"}. Vuoto = mantieni il valore salvato.'
        >
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
          label="Preferito"
          hint="Compare nella sezione Preferiti della overview"
          checked={favorite}
          onChange={setFavorite}
        />
        <ToggleField
          label="Comandi protetti"
          hint="Richiede il PIN prima di ogni azione"
          checked={protectedDevice}
          onChange={setProtectedDevice}
        />
      </div>

      <FormError message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Annulla
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || name.trim().length === 0 || stateTopic.trim().length === 0}
        >
          {busy ? 'Salvataggio…' : device ? 'Salva dispositivo' : 'Crea dispositivo'}
        </Button>
      </div>
    </form>
  );
}
