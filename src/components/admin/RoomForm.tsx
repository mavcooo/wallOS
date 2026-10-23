import { useState, type FormEvent } from 'react';

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
            placeholder="Garage"
          />
        </Field>
        <Field
          label="ID (slug)"
          hint={room ? 'Chiave stabile: non modificabile' : 'Usato in topic, scenari e API'}
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
        <Field label="Etichetta breve" hint="Mostrata nei chip e nelle card">
          <Input
            value={shortLabel}
            onChange={(event) => setShortLabel(event.target.value)}
            maxLength={24}
            placeholder="Garage"
          />
        </Field>
        <Field label="Icona" hint="Nome icona Lucide (es. sofa, car)">
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

      <FormError message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Annulla
        </Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
          {busy ? 'Salvataggio…' : room ? 'Salva stanza' : 'Crea stanza'}
        </Button>
      </div>
    </form>
  );
}
