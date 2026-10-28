import {
  Cpu,
  DoorOpen,
  Layers,
  MonitorSmartphone,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AutomationsTab } from '@/components/admin/AutomationsTab';
import { DeviceForm } from '@/components/admin/DeviceForm';
import { FloorplanEditor } from '@/components/admin/FloorplanEditor';
import { KioskManagerTab } from '@/components/admin/KioskManagerTab';
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
import { useDevices, useRooms, useScenarios } from '@/hooks/useTopologyQuery';
import { adminApi } from '@/lib/adminApi';
import { TOPOLOGY_QUERY_KEY } from '@/lib/queryClient';
import { roomLabel, type RoomConfig } from '@/lib/rooms';
import { useToastStore } from '@/store/toastStore';
import type { DeviceMetadata, Scenario } from '@/types/device';

type Tab = 'rooms' | 'devices' | 'scenarios' | 'automations' | 'displays' | 'floorplan';

/**
 * Le tab con il CRUD a dialog: automazioni, display e planimetria hanno i
 * propri controlli (il display si auto-registra, la pianta si edita in griglia).
 */
type CrudTab = Exclude<Tab, 'automations' | 'displays' | 'floorplan'>;

type Editing =
  | { kind: 'room'; item?: RoomConfig }
  | { kind: 'device'; item?: DeviceMetadata }
  | { kind: 'scenario'; item?: Scenario };

interface PendingDelete {
  kind: Tab;
  id: string;
  label: string;
}

const EDIT_TAB: Record<Editing['kind'], CrudTab> = {
  room: 'rooms',
  device: 'devices',
  scenario: 'scenarios',
};

// Le tab sono plurali, le chiavi i18n delle entità sono singolari.
const ENTITY_KEY: Record<CrudTab, 'room' | 'device' | 'scenario'> = {
  rooms: 'room',
  devices: 'device',
  scenarios: 'scenario',
};

export function AdminPage() {
  const { t } = useTranslation();
  // La topologia è server-state: dopo una mutazione si invalida la query e
  // TopologyGate riallinea le righe realtime dei device nuovi/rimossi.
  const rooms = useRooms();
  const devices = useDevices();
  const scenarios = useScenarios();
  const queryClient = useQueryClient();
  const pushToast = useToastStore((state) => state.push);

  const reloadTopology = () =>
    queryClient.invalidateQueries({ queryKey: TOPOLOGY_QUERY_KEY });

  const [tab, setTab] = useState<Tab>('rooms');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<PendingDelete | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const deviceList = devices;

  const finishEdit = async (message: string) => {
    setEditing(null);
    await reloadTopology();
    pushToast({
      title: message,
      description: t('admin.saved.description'),
      tone: 'success',
    });
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
        title: t('admin.deleted.title', { label: deleting.label }),
        description: t('admin.deleted.description'),
        tone: 'success',
      });
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : t('admin.deleted.failed'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const editButton = (label: string, onClick: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t('actions.edit', { name: label })}
      title={t('actions.edit', { name: label })}
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
      aria-label={t('actions.delete', { name: label })}
      title={t('actions.delete', { name: label })}
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
          {t('admin.title')}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">{t('admin.description')}</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="rooms">
              <DoorOpen className="size-4" /> {t('admin.tabs.rooms')}
            </TabsTrigger>
            <TabsTrigger value="devices">
              <Cpu className="size-4" /> {t('admin.tabs.devices')}
            </TabsTrigger>
            <TabsTrigger value="scenarios">
              <Sparkles className="size-4" /> {t('admin.tabs.scenarios')}
            </TabsTrigger>
            <TabsTrigger value="automations">
              <Workflow className="size-4" /> {t('admin.tabs.automations')}
            </TabsTrigger>
            <TabsTrigger value="displays">
              <MonitorSmartphone className="size-4" /> {t('admin.tabs.displays')}
            </TabsTrigger>
            <TabsTrigger value="floorplan">
              <Layers className="size-4" /> {t('admin.tabs.floorplan')}
            </TabsTrigger>
          </TabsList>
          {tab === 'automations' || tab === 'displays' || tab === 'floorplan' ? null : (
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
              {t(`admin.create.${ENTITY_KEY[tab]}`)}
            </Button>
          )}
        </div>

        <TabsContent value="rooms">
          {rooms.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
              {t('admin.empty.rooms')}
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
                        {t('admin.roomMeta', { id: room.id, count })}
                        {room.displayOrder !== undefined
                          ? t('admin.roomOrder', { order: room.displayOrder })
                          : ''}
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
              {t('admin.empty.devices')}
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
                        <Badge variant="outline">
                          {t(`admin.deviceKind.${device.kind}`)}
                        </Badge>
                        {device.favorite ? (
                          <Badge variant="accent">{t('admin.badges.favorite')}</Badge>
                        ) : null}
                        {device.protected ? (
                          <Badge variant="warning">{t('admin.badges.pin')}</Badge>
                        ) : null}
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
              {t('admin.empty.scenarios')}
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
                        <Badge variant="outline">
                          {t('admin.badges.steps', { count: scenario.steps.length })}
                        </Badge>
                        {scenario.protected ? (
                          <Badge variant="warning">{t('admin.badges.pin')}</Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-fg-subtle">
                        {scenario.id} · {scenario.description || t('admin.noDescription')}
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

        <TabsContent value="automations">
          <AutomationsTab />
        </TabsContent>

        <TabsContent value="displays">
          <KioskManagerTab />
        </TabsContent>

        <TabsContent value="floorplan">
          <FloorplanEditor />
        </TabsContent>
      </Tabs>

      <p className="flex items-start gap-2 rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        {t('admin.warning')}
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
                {t(
                  editing.item ? 'admin.dialog.edit' : 'admin.dialog.create',
                  { entity: t(`admin.entity.${ENTITY_KEY[EDIT_TAB[editing.kind]]}`) },
                )}
              </DialogTitle>
              <DialogDescription>
                {t(
                  editing.kind === 'room'
                    ? 'admin.dialog.roomDescription'
                    : editing.kind === 'device'
                      ? 'admin.dialog.deviceDescription'
                      : 'admin.dialog.scenarioDescription',
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4">
              {editing.kind === 'room' ? (
                <RoomForm
                  room={editing.item}
                  onCancel={() => setEditing(null)}
                  onSaved={() => void finishEdit(t('admin.saved.room'))}
                />
              ) : editing.kind === 'device' ? (
                <DeviceForm
                  device={editing.item}
                  rooms={rooms}
                  onCancel={() => setEditing(null)}
                  onSaved={() => void finishEdit(t('admin.saved.device'))}
                />
              ) : (
                <ScenarioForm
                  scenario={editing.item}
                  devices={deviceList}
                  onCancel={() => setEditing(null)}
                  onSaved={() => void finishEdit(t('admin.saved.scenario'))}
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
              <DialogTitle>
                {t('admin.deleteDialog.title', { label: deleting.label })}
              </DialogTitle>
              <DialogDescription>{t('admin.deleteDialog.description')}</DialogDescription>
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
                {t('actions.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void confirmDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy ? t('admin.deleteDialog.busy') : t('admin.deleteDialog.confirm')}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
