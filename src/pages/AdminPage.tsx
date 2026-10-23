import {
  Cpu,
  DoorOpen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';

import { DeviceForm } from '@/components/admin/DeviceForm';
import { RoomForm } from '@/components/admin/RoomForm';
import { ScenarioForm } from '@/components/admin/ScenarioForm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { adminApi } from '@/lib/adminApi';
import { roomLabel, type RoomConfig } from '@/lib/rooms';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type { Device, DeviceKind, Scenario } from '@/types/device';

type Tab = 'rooms' | 'devices' | 'scenarios';

type Editing =
  | { kind: 'room'; item?: RoomConfig }
  | { kind: 'device'; item?: Device }
  | { kind: 'scenario'; item?: Scenario };

interface PendingDelete {
  kind: Tab;
  id: string;
  label: string;
}

const DEVICE_TYPE_LABEL: Record<DeviceKind, string> = {
  light: 'Luce',
  climate: 'Clima',
  power: 'Energia',
  media: 'Media',
  sensor: 'Sensore',
};

const TAB_META: Record<Tab, { label: string; create: string; title: string }> = {
  rooms: { label: 'Stanze', create: 'Nuova stanza', title: 'stanza' },
  devices: { label: 'Dispositivi', create: 'Nuovo dispositivo', title: 'dispositivo' },
  scenarios: { label: 'Scenari', create: 'Nuovo scenario', title: 'scenario' },
};

const EDIT_TAB: Record<Editing['kind'], Tab> = {
  room: 'rooms',
  device: 'devices',
  scenario: 'scenarios',
};

export function AdminPage() {
  const rooms = useHomeStore((state) => state.rooms);
  const devices = useHomeStore((state) => state.devices);
  const scenarios = useHomeStore((state) => state.scenarios);
  const reloadTopology = useHomeStore((state) => state.reloadTopology);
  const pushToast = useToastStore((state) => state.push);

  const [tab, setTab] = useState<Tab>('rooms');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<PendingDelete | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const deviceList = Object.values(devices);

  const finishEdit = async (message: string) => {
    setEditing(null);
    await reloadTopology();
    pushToast({ title: message, description: 'Salvato su PostgreSQL.', tone: 'success' });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      if (deleting.kind === 'rooms') await adminApi.deleteRoom(deleting.id);
      else if (deleting.kind === 'devices') await adminApi.deleteDevice(deleting.id);
      else await adminApi.deleteScenario(deleting.id);

      setDeleting(null);
      await reloadTopology();
      pushToast({
        title: `${deleting.label} eliminato`,
        description: 'La topologia è aggiornata per tutti i pannelli.',
        tone: 'success',
      });
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Eliminazione non riuscita');
    } finally {
      setDeleteBusy(false);
    }
  };

  const editButton = (label: string, onClick: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Modifica ${label}`}
      title={`Modifica ${label}`}
      onClick={onClick}
    >
      <Pencil className="size-4" />
    </Button>
  );

  const deleteButton = (label: string, onClick: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="text-danger hover:bg-danger/10 hover:text-danger"
      aria-label={`Elimina ${label}`}
      title={`Elimina ${label}`}
      onClick={onClick}
    >
      <Trash2 className="size-4" />
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <Cpu className="size-4 text-accent" />
          Configurazione della casa
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
          Stanze, dispositivi e scenari sono righe di PostgreSQL. Ogni salvataggio passa dalle
          API protette (ruolo admin) e aggiorna subito lo store: nessun riavvio del kiosk.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="rooms">
              <DoorOpen className="size-4" /> Stanze
            </TabsTrigger>
            <TabsTrigger value="devices">
              <Cpu className="size-4" /> Dispositivi
            </TabsTrigger>
            <TabsTrigger value="scenarios">
              <Sparkles className="size-4" /> Scenari
            </TabsTrigger>
          </TabsList>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() =>
              setEditing(
                tab === 'rooms'
                  ? { kind: 'room' }
                  : tab === 'devices'
                    ? { kind: 'device' }
                    : { kind: 'scenario' },
              )
            }
          >
            <Plus className="size-4" />
            {TAB_META[tab].create}
          </Button>
        </div>

        <TabsContent value="rooms">
          {rooms.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
              Nessuna stanza: creane una per iniziare.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {rooms.map((room) => {
                const count = deviceList.filter((device) => device.room === room.id).length;
                return (
                  <article
                    key={room.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-panel px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{room.label}</p>
                      <p className="mt-0.5 truncate text-[10px] text-fg-subtle">
                        {room.id} · {count} dispositivi
                        {room.displayOrder !== undefined ? ` · ordine ${room.displayOrder}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      {editButton(room.label, () => setEditing({ kind: 'room', item: room }))}
                      {deleteButton(room.label, () => {
                        setDeleteError(null);
                        setDeleting({ kind: 'rooms', id: room.id, label: room.label });
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="devices">
          {deviceList.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
              Nessun dispositivo nel database.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel">
              <ul className="divide-y divide-line">
                {deviceList.map((device) => (
                  <li
                    key={device.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                        {device.name}
                        <Badge variant="outline">{DEVICE_TYPE_LABEL[device.kind]}</Badge>
                        {device.favorite ? <Badge variant="accent">Preferito</Badge> : null}
                        {device.protected ? <Badge variant="warning">PIN</Badge> : null}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-fg-subtle">
                        {device.id} · {roomLabel(rooms, device.room)} · {device.adapter} ·{' '}
                        {device.topics.state}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      {editButton(device.name, () => setEditing({ kind: 'device', item: device }))}
                      {deleteButton(device.name, () => {
                        setDeleteError(null);
                        setDeleting({ kind: 'devices', id: device.id, label: device.name });
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="scenarios">
          {scenarios.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
              Nessuno scenario nel database.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel">
              <ul className="divide-y divide-line">
                {scenarios.map((scenario) => (
                  <li
                    key={scenario.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                        {scenario.label}
                        <Badge variant="outline">{scenario.steps.length} passi</Badge>
                        {scenario.protected ? <Badge variant="warning">PIN</Badge> : null}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-fg-subtle">
                        {scenario.id} · {scenario.description || 'nessuna descrizione'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      {editButton(scenario.label, () =>
                        setEditing({ kind: 'scenario', item: scenario }),
                      )}
                      {deleteButton(scenario.label, () => {
                        setDeleteError(null);
                        setDeleting({
                          kind: 'scenarios',
                          id: scenario.id,
                          label: scenario.label,
                        });
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <p className="flex items-start gap-2 rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        Eliminare una stanza richiede che sia vuota. Eliminare un dispositivo non ripulisce gli
        eventuali passi di scenario che lo citano: controlla gli scenari prima.
      </p>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing ? (
          <DialogContent className="max-h-[92dvh] w-[min(94vw,44rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editing.item ? 'Modifica' : 'Nuovo'} {TAB_META[EDIT_TAB[editing.kind]].title}
              </DialogTitle>
              <DialogDescription>
                {editing.kind === 'room'
                  ? 'La stanza è visibile in overview, nella navigazione e nei filtri.'
                  : editing.kind === 'device'
                    ? 'Topic e adapter determinano come il kiosk parla con l’hardware.'
                    : 'I passi vengono eseguiti in ordine, con il ritardo dichiarato.'}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4">
              {editing.kind === 'room' ? (
                <RoomForm
                  room={editing.item}
                  onCancel={() => setEditing(null)}
                  onSaved={() => void finishEdit('Stanza salvata')}
                />
              ) : editing.kind === 'device' ? (
                <DeviceForm
                  device={editing.item}
                  rooms={rooms}
                  onCancel={() => setEditing(null)}
                  onSaved={() => void finishEdit('Dispositivo salvato')}
                />
              ) : (
                <ScenarioForm
                  scenario={editing.item}
                  devices={deviceList}
                  onCancel={() => setEditing(null)}
                  onSaved={() => void finishEdit('Scenario salvato')}
                />
              )}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
      >
        {deleting ? (
          <DialogContent className="w-[min(92vw,26rem)]">
            <DialogHeader>
              <DialogTitle>Eliminare {deleting.label}?</DialogTitle>
              <DialogDescription>
                L’operazione elimina la riga da PostgreSQL ed è immediata per tutti i pannelli.
              </DialogDescription>
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
                disabled={deleteBusy}
              >
                Annulla
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void confirmDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy ? 'Eliminazione…' : 'Elimina'}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
