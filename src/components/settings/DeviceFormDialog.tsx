import {
  Check,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Wifi,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCreateRoom, useCreateDevice, useUpdateDevice } from '@/hooks/useTopologyMutations';
import { useMqttSniffer } from '@/hooks/useMqttSniffer';
import type { DevicePayload } from '@/lib/adminApi';
import { roomIdFromLabel, type RoomConfig } from '@/lib/rooms';
import { cn } from '@/lib/utils';
import {
  isValidDeviceTopic,
  suggestFromTopic,
  type SnifferSuggestion,
} from '@/mqtt/sniffer';
import { useToastStore } from '@/store/toastStore';
import type {
  AdapterId,
  CameraAspectRatio,
  CameraProtocol,
  DeviceKind,
  DeviceMetadata,
} from '@/types/device';
import type { RawMqttMessage } from '@/types/mqtt';

const KINDS: readonly DeviceKind[] = [
  'light',
  'climate',
  'power',
  'media',
  'sensor',
  'camera',
];
const CAMERA_PROTOCOLS: readonly CameraProtocol[] = ['auto', 'webrtc', 'hls', 'mjpeg'];
const ASPECT_RATIOS: readonly CameraAspectRatio[] = ['16:9', '4:3'];
const ADAPTERS: readonly AdapterId[] = [
  'zigbee2mqtt',
  'shelly',
  'tasmota',
  'custom-json',
  'ha-discovery',
];
const SLUG_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

const topicSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(isValidDeviceTopic, 'Topic non valido: niente spazi o wildcard + / #');

interface Values {
  name: string;
  id: string;
  roomId: string;
  kind: DeviceKind;
  adapter: AdapterId;
  model: string;
  stateTopic: string;
  commandTopic: string;
  availabilityTopic: string;
  streamUrl: string;
  snapshotUrl: string;
  streamProtocol: CameraProtocol;
  aspectRatio: CameraAspectRatio;
  displayOrder: string;
  favorite: boolean;
  protectedDevice: boolean;
  channel: string;
  relay: string;
  fieldMapText: string;
}

function valuesFrom(device: DeviceMetadata | null | undefined, roomId: string): Values {
  return {
    name: device?.name ?? '',
    id: device?.id ?? '',
    roomId: device?.room ?? roomId,
    kind: device?.kind ?? 'light',
    adapter: (device?.discovery ? 'ha-discovery' : device?.adapter ?? 'zigbee2mqtt') as AdapterId,
    model: device?.model ?? '',
    stateTopic: device?.topics.state ?? '',
    commandTopic: device?.topics.command ?? '',
    availabilityTopic: device?.topics.availability ?? '',
    streamUrl: device?.kind === 'camera' ? device.stream.url : '',
    snapshotUrl: device?.kind === 'camera' ? (device.stream.snapshotUrl ?? '') : '',
    streamProtocol: device?.kind === 'camera' ? device.stream.protocol : 'auto',
    aspectRatio: device?.kind === 'camera' ? device.stream.aspectRatio : '16:9',
    displayOrder: String(device?.displayOrder ?? 0),
    favorite: device?.favorite ?? false,
    protectedDevice: device?.protected ?? false,
    channel: device?.fieldMap?.['channel'] ?? '0',
    relay: device?.fieldMap?.['relay'] ?? '1',
    fieldMapText: device?.fieldMap ? JSON.stringify(device.fieldMap, null, 2) : '',
  };
}

function parseFieldMap(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('fieldMap deve essere un oggetto JSON');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== 'string')) {
    throw new Error('I valori di fieldMap devono essere stringhe');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function DeviceFormDialog({
  open,
  onOpenChange,
  device,
  rooms,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  device?: DeviceMetadata | null;
  rooms: readonly RoomConfig[];
}) {
  const { t } = useTranslation();
  const { t: tSettings } = useTranslation('settings');
  const createDevice = useCreateDevice();
  const updateDevice = useUpdateDevice();
  const createRoom = useCreateRoom();
  const pushToast = useToastStore((state) => state.push);
  const sniffer = useMqttSniffer();

  const [values, setValues] = useState<Values>(() => valuesFrom(device, rooms[0]?.id ?? ''));
  const [tab, setTab] = useState<'manual' | 'sniffer'>('manual');
  const [idTouched, setIdTouched] = useState(Boolean(device));
  const [error, setError] = useState<string | null>(null);
  const [roomDraft, setRoomDraft] = useState('');
  const [roomFormOpen, setRoomFormOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState('');

  useEffect(() => {
    if (!open) return;
    setValues(valuesFrom(device, rooms[0]?.id ?? ''));
    setIdTouched(Boolean(device));
    setTab('manual');
    setError(null);
    setRoomDraft('');
    setRoomFormOpen(false);
    setFilterDraft('');
    // `rooms` cambia dopo la creazione rapida: non deve resettare il form aperto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, device]);

  // Lo sniffer ascolta solo mentre la tab è aperta; al cambio tab o alla
  // chiusura il cleanup annulla le wildcard.
  useEffect(() => {
    if (open && tab === 'sniffer') sniffer.start();
    else sniffer.stop();
    return () => sniffer.stop();
    // start/stop sono useCallback stabili.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  const busy = createDevice.isPending || updateDevice.isPending;
  const editing = Boolean(device);

  const patch = (next: Partial<Values>) =>
    setValues((current) => ({ ...current, ...next }));

  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string().trim().min(1, t('forms.device.nameRequired')).max(80),
          id: z.string().trim().max(64),
          roomId: z.string().trim().min(1, t('forms.device.roomRequired')),
          kind: z.enum(['light', 'climate', 'power', 'media', 'sensor', 'camera']),
          adapter: z.enum([
            'zigbee2mqtt',
            'shelly',
            'tasmota',
            'custom-json',
            'ha-discovery',
          ]),
          model: z.string().trim().max(80),
          stateTopic: z.string().trim().max(512),
          commandTopic: z.union([z.literal(''), topicSchema]),
          availabilityTopic: z.union([z.literal(''), topicSchema]),
          streamUrl: z.string().trim().max(1_024),
          snapshotUrl: z.string().trim().max(1_024),
          streamProtocol: z.enum(['webrtc', 'hls', 'mjpeg', 'auto']),
          aspectRatio: z.enum(['16:9', '4:3']),
          displayOrder: z.string(),
          favorite: z.boolean(),
          protectedDevice: z.boolean(),
          channel: z.string(),
          relay: z.string(),
          fieldMapText: z.string(),
        })
        .superRefine((data, context) => {
          if (data.id && !SLUG_RE.test(data.id)) {
            context.addIssue({
              code: 'custom',
              path: ['id'],
              message: tSettings('topology.deviceDialog.errors.id'),
            });
          }
          const order = Number(data.displayOrder);
          if (!Number.isInteger(order) || order < 0 || order > 9_999) {
            context.addIssue({
              code: 'custom',
              path: ['displayOrder'],
              message: tSettings('topology.deviceDialog.errors.order'),
            });
          }
          if (data.kind === 'camera') {
            if (!data.streamUrl) {
              context.addIssue({
                code: 'custom',
                path: ['streamUrl'],
                message: t('forms.device.camera.streamRequired'),
              });
            } else if (!/^(https?|webrtc):\/\/[^\s]+$/i.test(data.streamUrl)) {
              context.addIssue({
                code: 'custom',
                path: ['streamUrl'],
                message: t('forms.device.camera.streamInvalid'),
              });
            }
            if (data.snapshotUrl && !/^https?:\/\/[^\s]+$/i.test(data.snapshotUrl)) {
              context.addIssue({
                code: 'custom',
                path: ['snapshotUrl'],
                message: t('forms.device.camera.streamInvalid'),
              });
            }
          } else if (!isValidDeviceTopic(data.stateTopic)) {
            context.addIssue({
              code: 'custom',
              path: ['stateTopic'],
              message: tSettings('topology.deviceDialog.errors.topic'),
            });
          }
          if (data.adapter === 'custom-json') {
            try {
              parseFieldMap(data.fieldMapText);
            } catch (cause) {
              context.addIssue({
                code: 'custom',
                path: ['fieldMapText'],
                message: cause instanceof Error ? cause.message : 'fieldMap non valido',
              });
            }
          }
        }),
    [t, tSettings],
  );

  const applySuggestion = (suggestion: SnifferSuggestion) => {
    patch({
      adapter: suggestion.adapter,
      stateTopic: suggestion.stateTopic,
      commandTopic: suggestion.commandTopic ?? '',
      availabilityTopic: suggestion.availabilityTopic ?? '',
      name: values.name.trim() ? values.name : suggestion.name,
      ...(values.id.trim() ? {} : { id: roomIdFromLabel(suggestion.name || suggestion.stateTopic) }),
    });
    setTab('manual');
  };

  const createRoomNow = async () => {
    const name = roomDraft.trim();
    if (!name) return;
    try {
      const { room } = await createRoom.mutateAsync({ name });
      patch({ roomId: room.id });
      setRoomFormOpen(false);
      setRoomDraft('');
      pushToast({
        title: tSettings('topology.roomDialog.created', { name: room.label }),
        tone: 'success',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('forms.saveFailed'));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? tSettings('topology.deviceDialog.errors.invalid'));
      return;
    }
    const data = parsed.data;

    try {
      const existing = device?.fieldMap ?? {};
      let fieldMap: Record<string, string> | undefined;
      if (data.adapter === 'custom-json') {
        fieldMap = parseFieldMap(data.fieldMapText) ?? {};
      } else if (data.adapter === 'shelly') {
        fieldMap = { ...existing, channel: String(Number(data.channel) || 0) };
      } else if (data.adapter === 'tasmota') {
        fieldMap = { ...existing, relay: String(Number(data.relay) || 1) };
      }

      const camera = data.kind === 'camera';
      const payload: DevicePayload = {
        roomId: data.roomId,
        name: data.name,
        type: data.kind,
        adapter: data.adapter,
        model: data.model || null,
        stateTopic: data.stateTopic,
        commandTopic: camera ? null : data.commandTopic || null,
        availabilityTopic: camera ? null : data.availabilityTopic || null,
        favorite: data.favorite,
        protected: data.protectedDevice,
        displayOrder: Number(data.displayOrder) || 0,
        ...(fieldMap ? { fieldMap } : {}),
        ...(camera
          ? {
              streamUrl: data.streamUrl,
              snapshotUrl: data.snapshotUrl || null,
              streamProtocol: data.streamProtocol,
              aspectRatio: data.aspectRatio,
            }
          : {}),
      };

      if (device) {
        await updateDevice.mutateAsync({ id: device.id, payload });
        pushToast({ title: tSchemaSaved('updated'), tone: 'success' });
      } else {
        await createDevice.mutateAsync({
          ...payload,
          id: data.id.trim() || undefined,
        });
        pushToast({ title: tSchemaSaved('created'), tone: 'success' });
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('forms.saveFailed'));
    }
  };

  function tSchemaSaved(kind: 'created' | 'updated'): string {
    return tSettings(`topology.deviceDialog.toasts.${kind}`);
  }



  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[92dvh] w-[min(96vw,52rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {tSettings(editing ? 'topology.deviceDialog.editTitle' : 'topology.deviceDialog.createTitle')}
          </DialogTitle>
          <DialogDescription>
            {tSettings('topology.deviceDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as 'manual' | 'sniffer')}
          className="mt-4 flex flex-col gap-4"
        >
          <TabsList className="self-start">
            <TabsTrigger value="manual">
              <Wifi className="size-4" /> {tSettings('topology.deviceDialog.manualTab')}
            </TabsTrigger>
            <TabsTrigger value="sniffer">
              <Radio className="size-4" /> {tSettings('topology.deviceDialog.snifferTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sniffer">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[11px]',
                    sniffer.active ? 'text-success' : 'text-fg-subtle',
                  )}
                >
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      sniffer.active ? 'animate-pulse bg-success' : 'bg-fg-subtle',
                    )}
                  />
                  {sniffer.active ? tSettings('topology.sniffer.listening') : tSettings('topology.sniffer.idle')}
                </span>
                <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
                  {sniffer.filters.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => sniffer.removeFilter(filter)}
                      className="rounded-full border border-line bg-panel px-2 py-1 font-mono text-[10px] text-fg-muted hover:text-danger"
                      title={tSettings('topology.sniffer.removeFilter')}
                    >
                      {filter}
                    </button>
                  ))}
                  <Input
                    className="h-9 w-32 text-[11px]"
                    value={filterDraft}
                    onChange={(event) => setFilterDraft(event.target.value)}
                    placeholder={tSettings('topology.sniffer.filterPlaceholder')}
                    aria-label={tSettings('topology.sniffer.addFilter')}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      if (sniffer.addFilter(filterDraft)) setFilterDraft('');
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (sniffer.addFilter(filterDraft)) setFilterDraft('');
                    }}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={sniffer.clear}>
                    <RefreshCw className="size-3.5" /> {tSettings('topology.sniffer.clear')}
                  </Button>
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-fg-subtle">
                {tSettings('topology.sniffer.hint')}
              </p>

              <div className="max-h-72 overflow-y-auto rounded-xl border border-line bg-bg/60 kiosk-scroll">
                {sniffer.messages.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 p-8 text-center text-[11px] text-fg-subtle">
                    <Search className="size-5" />
                    {tSettings('topology.sniffer.empty')}
                  </div>
                ) : (
                  <ul className="divide-y divide-line/60">
                    {sniffer.messages.map((message: RawMqttMessage) => {
                      const suggestion = suggestFromTopic(message.topic);
                      return (
                        <li key={message.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate font-mono text-[11px] text-fg">
                                {message.topic}
                              </p>
                              <p className="break-all font-mono text-[10px] text-fg-subtle">
                                {message.payload}
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="shrink-0"
                              onClick={() => applySuggestion(suggestion)}
                            >
                              <Check className="size-3.5" />
                              {tSettings('topology.sniffer.useTopic')}
                            </Button>
                          </div>
                          <p className="text-[9px] uppercase tracking-wide text-fg-subtle">
                            {tSettings('topology.sniffer.detected', {
                              adapter: suggestion.adapter,
                            })}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="manual">
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-name">{t('forms.name')}</Label>
                  <Input
                    id="device-name"
                    value={values.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      setValues((current) => ({
                        ...current,
                        name,
                        id:
                          idTouched || editing
                            ? current.id
                            : roomIdFromLabel(name),
                      }));
                    }}
                    maxLength={80}
                    required
                    placeholder={t('forms.device.namePlaceholder')}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-id">{t('forms.id')}</Label>
                  <Input
                    id="device-id"
                    value={values.id}
                    onChange={(event) => {
                      setIdTouched(true);
                      patch({ id: event.target.value.toLowerCase() });
                    }}
                    disabled={editing}
                    maxLength={64}
                    placeholder="light-garage"
                    spellCheck={false}
                  />
                  <span className="text-[10px] text-fg-subtle">
                    {editing ? t('forms.idLocked') : t('forms.idHint')}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-room">{t('forms.device.room')}</Label>
                  <div className="flex gap-2">
                    <select
                      id="device-room"
                      value={values.roomId}
                      onChange={(event) => patch({ roomId: event.target.value })}
                      className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                    >
                      {rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setRoomFormOpen((current) => !current)}
                      aria-label={tSettings('topology.deviceDialog.newRoom')}
                      title={tSettings('topology.deviceDialog.newRoom')}
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                  {roomFormOpen ? (
                    <div className="flex gap-2 rounded-xl border border-line bg-panel-2 p-2">
                      <Input
                        value={roomDraft}
                        onChange={(event) => setRoomDraft(event.target.value)}
                        placeholder={tSettings('topology.roomDialog.namePlaceholder')}
                        className="h-9 text-xs"
                        maxLength={80}
                        aria-label={tSettings('topology.deviceDialog.newRoom')}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => void createRoomNow()}
                        disabled={createRoom.isPending || roomDraft.trim().length === 0}
                      >
                        {createRoom.isPending
                          ? tSettings('topology.roomDialog.saving')
                          : tSettings('topology.deviceDialog.createRoom')}
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-kind">{t('forms.device.type')}</Label>
                  <select
                    id="device-kind"
                    value={values.kind}
                    onChange={(event) => patch({ kind: event.target.value as DeviceKind })}
                    className="h-11 rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`forms.device.types.${kind}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-adapter">{t('forms.device.adapter')}</Label>
                  <select
                    id="device-adapter"
                    value={values.adapter}
                    onChange={(event) => patch({ adapter: event.target.value as AdapterId })}
                    className="h-11 rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                  >
                    {ADAPTERS.map((adapter) => (
                      <option key={adapter} value={adapter}>
                        {t(`forms.device.adapters.${adapter}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-model">{t('forms.device.model')}</Label>
                  <Input
                    id="device-model"
                    value={values.model}
                    onChange={(event) => patch({ model: event.target.value })}
                    maxLength={80}
                    placeholder="Ikea TRADFRI"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {values.kind === 'camera' ? (
                  <>
                    <div className="flex flex-col gap-1.5 sm:col-span-2">
                      <Label htmlFor="device-stream-url">
                        {t('forms.device.camera.streamUrl')}
                      </Label>
                      <Input
                        id="device-stream-url"
                        value={values.streamUrl}
                        onChange={(event) => patch({ streamUrl: event.target.value })}
                        maxLength={1_024}
                        placeholder="http://192.168.0.59:1984/api/webrtc?src=porta_ingresso"
                        spellCheck={false}
                      />
                      <span className="text-[10px] leading-relaxed text-fg-subtle">
                        {t('forms.device.camera.streamUrlHint')}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="device-snapshot-url">
                        {t('forms.device.camera.snapshotUrl')}
                      </Label>
                      <Input
                        id="device-snapshot-url"
                        value={values.snapshotUrl}
                        onChange={(event) => patch({ snapshotUrl: event.target.value })}
                        maxLength={1_024}
                        placeholder="http://192.168.0.59:1984/api/frame.jpeg?src=porta_ingresso"
                        spellCheck={false}
                      />
                      <span className="text-[10px] text-fg-subtle">
                        {t('forms.device.camera.snapshotHint')}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="device-stream-protocol">
                        {t('forms.device.camera.protocol')}
                      </Label>
                      <select
                        id="device-stream-protocol"
                        value={values.streamProtocol}
                        onChange={(event) =>
                          patch({ streamProtocol: event.target.value as CameraProtocol })
                        }
                        className="h-11 rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                      >
                        {CAMERA_PROTOCOLS.map((protocol) => (
                          <option key={protocol} value={protocol}>
                            {t(`forms.device.camera.protocols.${protocol}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="device-aspect-ratio">
                        {t('forms.device.camera.aspectRatio')}
                      </Label>
                      <select
                        id="device-aspect-ratio"
                        value={values.aspectRatio}
                        onChange={(event) =>
                          patch({ aspectRatio: event.target.value as CameraAspectRatio })
                        }
                        className="h-11 rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                      >
                        {ASPECT_RATIOS.map((ratio) => (
                          <option key={ratio} value={ratio}>
                            {t(`forms.device.camera.aspectRatios.${ratio}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="device-state-topic">{t('forms.device.stateTopic')}</Label>
                      <Input
                        id="device-state-topic"
                        value={values.stateTopic}
                        onChange={(event) => patch({ stateTopic: event.target.value })}
                        maxLength={512}
                        placeholder="zigbee2mqtt/garage/light"
                        spellCheck={false}
                      />
                      {!isValidDeviceTopic(values.stateTopic) ? (
                        <span className="text-[10px] text-danger">
                          {tSettings('topology.deviceDialog.errors.topic')}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="device-command-topic">{t('forms.device.commandTopic')}</Label>
                      <Input
                        id="device-command-topic"
                        value={values.commandTopic}
                        onChange={(event) => patch({ commandTopic: event.target.value })}
                        maxLength={512}
                        placeholder="zigbee2mqtt/garage/light/set"
                        spellCheck={false}
                      />
                      <span className="text-[10px] text-fg-subtle">
                        {t('forms.device.commandHint')}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="device-availability-topic">
                        {t('forms.device.availabilityTopic')}
                      </Label>
                      <Input
                        id="device-availability-topic"
                        value={values.availabilityTopic}
                        onChange={(event) => patch({ availabilityTopic: event.target.value })}
                        maxLength={512}
                        placeholder="zigbee2mqtt/garage/light/availability"
                        spellCheck={false}
                      />
                      <span className="text-[10px] text-fg-subtle">
                        {t('forms.device.availabilityHint')}
                      </span>
                    </div>
                  </>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-order">{t('forms.order')}</Label>
                  <Input
                    id="device-order"
                    type="number"
                    min={0}
                    max={9999}
                    value={values.displayOrder}
                    onChange={(event) => patch({ displayOrder: event.target.value })}
                  />
                </div>
              </div>

              {values.adapter === 'shelly' ? (
                <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-panel-2/60 p-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="device-channel">{tSettings('topology.deviceDialog.channel')}</Label>
                    <Input
                      id="device-channel"
                      type="number"
                      min={0}
                      max={16}
                      value={values.channel}
                      onChange={(event) => patch({ channel: event.target.value })}
                    />
                    <span className="text-[10px] text-fg-subtle">
                      {tSettings('topology.deviceDialog.channelHint')}
                    </span>
                  </div>
                </div>
              ) : null}

              {values.adapter === 'tasmota' ? (
                <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-panel-2/60 p-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="device-relay">{tSettings('topology.deviceDialog.relay')}</Label>
                    <Input
                      id="device-relay"
                      type="number"
                      min={1}
                      max={8}
                      value={values.relay}
                      onChange={(event) => patch({ relay: event.target.value })}
                    />
                    <span className="text-[10px] text-fg-subtle">
                      {tSettings('topology.deviceDialog.relayHint')}
                    </span>
                  </div>
                </div>
              ) : null}

              {values.adapter === 'custom-json' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-field-map">{t('forms.device.fieldMap')}</Label>
                  <textarea
                    id="device-field-map"
                    value={values.fieldMapText}
                    onChange={(event) => patch({ fieldMapText: event.target.value })}
                    rows={4}
                    spellCheck={false}
                    placeholder={'{"on":"relay.state","brightness":"dimmer.value"}'}
                    className="w-full rounded-xl border border-line bg-panel-2 px-3 py-2 font-mono text-[11px] text-fg focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                  />
                  <span className="text-[10px] leading-relaxed text-fg-subtle">
                    {t('forms.device.fieldMapHint')}
                  </span>
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-xl border border-line bg-panel-2 px-3 py-2.5">
                  <div>
                    <p className="text-xs font-medium text-fg">{t('forms.device.favorite')}</p>
                    <p className="text-[10px] text-fg-subtle">{t('forms.device.favoriteHint')}</p>
                  </div>
                  <Switch
                    checked={values.favorite}
                    onCheckedChange={(favorite) => patch({ favorite })}
                    aria-label={t('forms.device.favorite')}
                  />
                </div>
                <div className="flex items-center justify-between rounded-xl border border-line bg-panel-2 px-3 py-2.5">
                  <div>
                    <p className="text-xs font-medium text-fg">{t('forms.device.protected')}</p>
                    <p className="text-[10px] text-fg-subtle">{t('forms.device.protectedHint')}</p>
                  </div>
                  <Switch
                    checked={values.protectedDevice}
                    onCheckedChange={(protectedDevice) => patch({ protectedDevice })}
                    aria-label={t('forms.device.protected')}
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
                  {t('forms.cancel')}
                </Button>
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy
                    ? t('forms.saving')
                    : t(editing ? 'forms.device.save' : 'forms.device.create')}
                </Button>
              </div>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
