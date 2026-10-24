import {
  Cpu,
  DoorOpen,
  Pencil,
  Plus,
  RadioTower,
  Send,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { DeviceFormDialog } from '@/components/settings/DeviceFormDialog';
import { RoomFormDialog } from '@/components/settings/RoomFormDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import {
  useDeleteDevice,
  useDeleteRoom,
} from '@/hooks/useTopologyMutations';
import { useDevices, useRooms } from '@/hooks/useTopologyQuery';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { roomLabel, type RoomConfig } from '@/lib/rooms';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import { useToastStore } from '@/store/toastStore';
import type { DeviceMetadata } from '@/types/device';

type PendingDelete =
  | { kind: 'device'; id: string; label: string }
  | { kind: 'room'; id: string; label: string };

function AvailabilityBadge({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('settings');
  const availability = useHomeStore(
    (state) => state.deviceStates[deviceId]?.availability ?? 'unknown',
  );
  return (
    <Badge
      variant={
        availability === 'online' ? 'success' : availability === 'offline' ? 'danger' : 'outline'
      }
    >
      {t(`topology.availability.${availability}`)}
    </Badge>
  );
}

const selectClass =
  'h-9 rounded-xl border border-line bg-panel-2 px-2.5 text-xs text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20';

export function TopologyManager() {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation();
  const devices = useDevices();
  const rooms = useRooms();
  const current = useCurrentUser();
  const requestPin = usePinGuard();
  const deleteDevice = useDeleteDevice();
  const deleteRoom = useDeleteRoom();
  const { publishRaw } = useMqttApi();
  const pushToast = useToastStore((state) => state.push);

  const [tab, setTab] = useState<'devices' | 'rooms'>('devices');
  const [roomFilter, setRoomFilter] = useState('all');
  const [adapterFilter, setAdapterFilter] = useState('all');
  const [deviceDialog, setDeviceDialog] = useState<
    { device?: DeviceMetadata } | null
  >(null);
  const [roomDialog, setRoomDialog] = useState<{ room?: RoomConfig } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testTarget, setTestTarget] = useState<DeviceMetadata | null>(null);
  const [testTopic, setTestTopic] = useState('');
  const [testPayload, setTestPayload] = useState('{"state":"ON"}');

  const adapters = useMemo(
    () => [...new Set(devices.map((device) => device.adapter))].sort(),
    [devices],
  );

  const filtered = useMemo(
    () =>
      devices.filter(
        (device) =>
          (roomFilter === 'all' || device.room === roomFilter) &&
          (adapterFilter === 'all' || device.adapter === adapterFilter),
      ),
    [devices, roomFilter, adapterFilter],
  );

  const guard = (run: () => void) => {
    if (current.elevated) {
      run();
      return;
    }
    requestPin({
      title: t('topology.pin.title'),
      description: t('topology.pin.description'),
      action: t('topology.pin.action'),
      onConfirm: run,
    });
  };

  const openEditDevice = (device: DeviceMetadata) =>
    guard(() => setDeviceDialog({ device }));
  const openCreateDevice = () => guard(() => setDeviceDialog({}));
  const openEditRoom = (room: RoomConfig) => guard(() => setRoomDialog({ room }));
  const openCreateRoom = () => guard(() => setRoomDialog({}));

  const openDelete = (next: PendingDelete) =>
    guard(() => {
      setDeleteError(null);
      setPendingDelete(next);
    });

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    try {
      if (pendingDelete.kind === 'device') await deleteDevice.mutateAsync(pendingDelete.id);
      else await deleteRoom.mutateAsync(pendingDelete.id);
      pushToast({
        title: t('topology.deleted.title', { label: pendingDelete.label }),
        tone: 'success',
      });
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('topology.deleted.failed'));
    }
  };

  const openTest = (device: DeviceMetadata) => {
    setTestTarget(device);
    setTestTopic(device.topics.state);
    setTestPayload(
      device.kind === 'light' || device.kind === 'power'
        ? '{"state":"ON"}'
        : '{"temperature":21.5}',
    );
  };

  const publishTest = () => {
    if (!testTarget || !testTopic.trim()) return;
    publishRaw(testTopic.trim(), testPayload);
    pushToast({
      title: t('topology.test.published'),
      description: testTopic.trim(),
      tone: 'info',
    });
    setTestTarget(null);
  };

  const deleting = deleteDevice.isPending || deleteRoom.isPending;

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <RadioTower className="size-4 text-accent" />
            {t('topology.title')}
          </h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-fg-subtle">
            {t('topology.description')}
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={tab === 'devices' ? openCreateDevice : openCreateRoom}
        >
          <Plus className="size-4" />
          {t(tab === 'devices' ? 'topology.addDevice' : 'topology.addRoom')}
        </Button>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as 'devices' | 'rooms')}
        className="flex flex-col gap-3 p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="devices">
              <Cpu className="size-4" /> {t('topology.tabs.devices', { count: devices.length })}
            </TabsTrigger>
            <TabsTrigger value="rooms">
              <DoorOpen className="size-4" /> {t('topology.tabs.rooms', { count: rooms.length })}
            </TabsTrigger>
          </TabsList>

          {tab === 'devices' ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={t('topology.filters.room')}
                className={selectClass}
                value={roomFilter}
                onChange={(event) => setRoomFilter(event.target.value)}
              >
                <option value="all">{t('topology.filters.allRooms')}</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('topology.filters.adapter')}
                className={selectClass}
                value={adapterFilter}
                onChange={(event) => setAdapterFilter(event.target.value)}
              >
                <option value="all">{t('topology.filters.allAdapters')}</option>
                {adapters.map((adapter) => (
                  <option key={adapter} value={adapter}>
                    {adapter}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-fg-subtle">
                {t('topology.filters.count', { count: filtered.length })}
              </span>
            </div>
          ) : null}
        </div>

        <TabsContent value="devices">
          {filtered.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[11px] text-fg-subtle">
              {t('topology.empty.devices')}
            </p>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line">
              <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] gap-3 border-b border-line bg-panel-2/60 px-4 py-2 text-[10px] uppercase tracking-wider text-fg-subtle md:grid">
                <span>{t('topology.table.device')}</span>
                <span>{t('topology.table.topics')}</span>
                <span>{t('topology.table.status')}</span>
                <span className="text-right">{t('topology.table.actions')}</span>
              </div>
              <ul className="divide-y divide-line">
                {filtered.map((device) => (
                  <li
                    key={device.id}
                    className="flex flex-col gap-3 px-4 py-3 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] md:items-center"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                        <span className="truncate">{device.name}</span>
                        <Badge variant="outline">{device.adapter}</Badge>
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-fg-subtle">
                        {device.id} · {roomLabel(rooms, device.room)} · {device.kind}
                      </p>
                    </div>
                    <div className="min-w-0 text-[10px] text-fg-subtle">
                      <p className="truncate font-mono text-fg-muted">
                        {device.kind === 'camera' ? device.stream.url : device.topics.state}
                      </p>
                      <p className="truncate font-mono">
                        {device.topics.command ?? t('topology.noCommand')}
                      </p>
                    </div>
                    <AvailabilityBadge deviceId={device.id} />
                    <div className="flex items-center justify-start gap-1 md:justify-end">
                      {device.kind === 'camera' ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => openTest(device)}
                          title={t('topology.actions.test')}
                        >
                          <Send className="size-3.5" />
                          <span className="md:sr-only">{t('topology.actions.test')}</span>
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('topology.actions.edit', { name: device.name })}
                        title={t('topology.actions.edit', { name: device.name })}
                        onClick={() => openEditDevice(device)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-danger hover:bg-danger/10 hover:text-danger"
                        aria-label={t('topology.actions.delete', { name: device.name })}
                        title={t('topology.actions.delete', { name: device.name })}
                        onClick={() =>
                          openDelete({ kind: 'device', id: device.id, label: device.name })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="rooms">
          {rooms.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[11px] text-fg-subtle">
              {t('topology.empty.rooms')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {rooms.map((room) => {
                const count = devices.filter((device) => device.room === room.id).length;
                return (
                  <article
                    key={room.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-panel-2/40 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{room.label}</p>
                      <p className="truncate text-[10px] text-fg-subtle">
                        {t('topology.roomMeta', { id: room.id, count })}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('topology.actions.editRoom', { name: room.label })}
                        onClick={() => openEditRoom(room)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-danger hover:bg-danger/10 hover:text-danger"
                        aria-label={t('topology.actions.deleteRoom', { name: room.label })}
                        onClick={() =>
                          openDelete({ kind: 'room', id: room.id, label: room.label })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <DeviceFormDialog
        open={deviceDialog !== null}
        onOpenChange={(open) => {
          if (!open) setDeviceDialog(null);
        }}
        device={deviceDialog?.device}
        rooms={rooms}
      />

      <RoomFormDialog
        open={roomDialog !== null}
        onOpenChange={(open) => {
          if (!open) setRoomDialog(null);
        }}
        room={roomDialog?.room}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        {pendingDelete ? (
          <DialogContent className="w-[min(92vw,26rem)]">
            <DialogHeader>
              <DialogTitle>
                {t('topology.deleteDialog.title', { label: pendingDelete.label })}
              </DialogTitle>
              <DialogDescription>
                {t(
                  pendingDelete.kind === 'room'
                    ? 'topology.deleteDialog.roomDescription'
                    : 'topology.deleteDialog.deviceDescription',
                )}
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
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                {tCommon('actions.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting
                  ? t('topology.deleteDialog.busy')
                  : t('topology.deleteDialog.confirm')}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={testTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTestTarget(null);
        }}
      >
        {testTarget ? (
          <DialogContent className="w-[min(92vw,30rem)]">
            <DialogHeader>
              <DialogTitle>{t('topology.test.title', { name: testTarget.name })}</DialogTitle>
              <DialogDescription>{t('topology.test.description')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="test-topic">{t('topology.test.topic')}</Label>
                <Input
                  id="test-topic"
                  value={testTopic}
                  onChange={(event) => setTestTopic(event.target.value)}
                  spellCheck={false}
                  className={cn(
                    'font-mono text-xs',
                    !testTopic.trim() && 'border-danger/50',
                  )}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="test-payload">{t('topology.test.payload')}</Label>
                <textarea
                  id="test-payload"
                  value={testPayload}
                  onChange={(event) => setTestPayload(event.target.value)}
                  rows={4}
                  spellCheck={false}
                  className="w-full rounded-xl border border-line bg-panel-2 px-3 py-2 font-mono text-[11px] text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                />
              </div>
              <p className="text-[10px] leading-relaxed text-fg-subtle">
                {t('topology.test.note')}
              </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setTestTarget(null)}
              >
                {tCommon('actions.cancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={publishTest}
                disabled={!testTopic.trim()}
              >
                <Send className="size-4" /> {t('topology.test.publish')}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}
