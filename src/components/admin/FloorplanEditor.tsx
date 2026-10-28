import {
  Building2,
  Camera,
  Check,
  Layers,
  Lightbulb,
  Plug,
  Plus,
  Save,
  Speaker,
  Thermometer,
  Trash2,
  Waypoints,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Field, FormError, selectClass } from '@/components/admin/fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import {
  useCreateFloor,
  useDeleteFloor,
  useFloorplanQuery,
  useSaveFloorLayout,
  useUpdateFloor,
} from '@/hooks/useFloorplan';
import { useDevices, useRooms } from '@/hooks/useTopologyQuery';
import {
  DEFAULT_PIN_POSITION,
  FLOORPLAN_GRID,
  ROOM_COLORS,
  firstFreeLayout,
  moveRoomLayout,
  normalizeGridLayout,
  normalizePinPosition,
  resizeRoomLayout,
  type RoomColor,
} from '@/lib/floorplan';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/store/toastStore';
import type { DeviceKind } from '@/types/device';
import type {
  DevicePinPosition,
  Floor,
  FloorLayoutPayload,
  FloorRoomDevice,
  RoomGridLayout,
} from '@/types/floorplan';

/** Icona del marker nell'editor, coerente con la legenda dei widget. */
const DEVICE_ICONS: Record<DeviceKind, LucideIcon> = {
  light: Lightbulb,
  climate: Thermometer,
  power: Plug,
  media: Speaker,
  sensor: Waypoints,
  camera: Camera,
};

/** Stanza in modifica: geometria dello bozza + marker dei suoi dispositivi. */
interface EditorDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  pin: DevicePinPosition;
}

interface EditorRoom {
  id: string;
  label: string;
  layout: RoomGridLayout;
  devices: EditorDevice[];
  /** Piano di provenienza: distingue una stanza "tolta" da una appena aggiunta. */
  originFloorId: string | null;
}

interface EditorState {
  floorId: string;
  rooms: EditorRoom[];
  /** Stanze tolte dal piano in questa bozza: al salvataggio passano a `null`. */
  removed: EditorRoom[];
}

function toEditorRoom(
  room: { id: string; label: string; gridLayout: RoomGridLayout; floorId: string | null },
  devices: readonly FloorRoomDevice[] | readonly EditorDevice[],
): EditorRoom {
  return {
    id: room.id,
    label: room.label,
    layout: normalizeGridLayout(room.gridLayout),
    originFloorId: room.floorId,
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      pin: normalizePinPosition('pin' in device ? device.pin : device.roomPinPosition),
    })),
  };
}

function buildEditorState(
  floor: Floor,
  devicesByRoom: ReadonlyMap<string, EditorDevice[]>,
): EditorState {
  const rooms = floor.rooms.map((room) => toEditorRoom(room, room.devices));
  // Una stanza senza dispositivi (o con device appena scoperti) completa i
  // marker dalla topologia: la planimetria resta editabile subito.
  for (const room of rooms) {
    if (room.devices.length === 0) room.devices = devicesByRoom.get(room.id) ?? [];
  }
  return { floorId: floor.id, rooms, removed: [] };
}

interface PinDragState {
  deviceId: string;
  rect: DOMRect;
}

interface RoomDragState {
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  layout: RoomGridLayout;
  cellWidth: number;
  cellHeight: number;
}

/** Blocco stanza dell'editor: drag per spostare, angolo per ridimensionare. */
const EditorRoomBlock = memo(function EditorRoomBlock({
  room,
  gridRef,
  onLayout,
  onPin,
  onRemove,
}: {
  room: EditorRoom;
  gridRef: RefObject<HTMLDivElement | null>;
  onLayout: (roomId: string, layout: RoomGridLayout) => void;
  onPin: (deviceId: string, position: DevicePinPosition) => void;
  onRemove: (roomId: string) => void;
}) {
  const { t } = useTranslation('floorplan');
  const blockRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<RoomDragState | null>(null);
  const pinDragRef = useRef<PinDragState | null>(null);

  const startDrag = (mode: RoomDragState['mode']) =>
    (event: ReactPointerEvent<HTMLElement>) => {
      const grid = gridRef.current;
      if (!grid) return;
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      const rect = grid.getBoundingClientRect();
      dragRef.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        layout: room.layout,
        cellWidth: rect.width / FLOORPLAN_GRID.cols,
        cellHeight: rect.height / FLOORPLAN_GRID.rows,
      };
    };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    // Snap-to-grid: il delta in pixel diventa un numero intero di celle.
    const dCol = Math.round((event.clientX - drag.startX) / drag.cellWidth);
    const dRow = Math.round((event.clientY - drag.startY) / drag.cellHeight);
    onLayout(
      room.id,
      drag.mode === 'move'
        ? moveRoomLayout(drag.layout, dCol, dRow)
        : resizeRoomLayout(drag.layout, dCol, dRow),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
  };

  const startPinDrag =
    (deviceId: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Il marker non deve spostare la stanza: solo la propria posizione.
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      const rect = blockRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      pinDragRef.current = { deviceId, rect };
    };

  const movePin = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pinDragRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    onPin(drag.deviceId, {
      x: Math.min(96, Math.max(4, ((event.clientX - drag.rect.left) / drag.rect.width) * 100)),
      y: Math.min(92, Math.max(8, ((event.clientY - drag.rect.top) / drag.rect.height) * 100)),
    });
  };

  const endPinDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!pinDragRef.current) return;
    event.stopPropagation();
    pinDragRef.current = null;
  };

  return (
    <div
      ref={blockRef}
      data-editor-room={room.id}
      style={{
        gridColumn: `${room.layout.col} / span ${room.layout.colSpan}`,
        gridRow: `${room.layout.row} / span ${room.layout.rowSpan}`,
      }}
      // Tutto il blocco è la maniglia: pin, pulsante di rimozione e angolo
      // fermano la propagazione, quindi ognuno mantiene la propria gesture.
      onPointerDown={startDrag('move')}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        const deltas: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        const delta = deltas[event.key];
        if (!delta) return;
        event.preventDefault();
        onLayout(room.id, moveRoomLayout(room.layout, delta[0], delta[1]));
      }}
      role="group"
      tabIndex={0}
      aria-label={`${room.label}: ${room.layout.col},${room.layout.row}`}
      className="relative z-[2] flex min-h-0 min-w-0 cursor-grab touch-none select-none flex-col overflow-hidden rounded-xl border border-accent/40 bg-panel/95 p-1.5 shadow-lg active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1 touch-none">
          <p className="truncate text-[11px] font-semibold leading-tight text-fg">
            {room.label}
          </p>
          <p className="tabular text-[9px] leading-tight text-fg-subtle">
            {room.layout.col},{room.layout.row} · {room.layout.colSpan}×{room.layout.rowSpan}
          </p>
        </div>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(room.id);
          }}
          aria-label={t('editor.removeRoom')}
          title={t('editor.removeRoom')}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-danger/15 hover:text-danger"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {room.devices.map((device) => {
        const DeviceIcon = DEVICE_ICONS[device.kind] ?? Waypoints;
        return (
          <button
            key={device.id}
            type="button"
            aria-label={t('editor.devicePin', { name: device.name })}
            title={device.name}
            style={{ left: `${device.pin.x}%`, top: `${device.pin.y}%`, touchAction: 'none' }}
            onPointerDown={startPinDrag(device.id)}
            onPointerMove={movePin}
            onPointerUp={endPinDrag}
            onPointerCancel={endPinDrag}
            onContextMenu={(event) => event.preventDefault()}
            className="absolute z-[3] flex size-7 -translate-x-1/2 -translate-y-1/2 cursor-move items-center justify-center rounded-full border border-warning/40 bg-warning/20 text-warning shadow active:scale-95"
          >
            <DeviceIcon className="size-3" aria-hidden="true" />
          </button>
        );
      })}

      {/* Maniglia di ridimensionamento: angolo in basso a destra, 28 px. */}
      <span
        role="presentation"
        aria-hidden="true"
        onPointerDown={startDrag('resize')}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ touchAction: 'none' }}
        className="absolute bottom-0 right-0 z-[4] flex size-7 cursor-nwse-resize items-end justify-end p-1"
      >
        <span className="size-2.5 rounded-sm border-b-2 border-r-2 border-accent/80" />
      </span>
    </div>
  );
});

/**
 * Admin → Planimetria ("Personalizza Pianta").
 *
 * - piani: creazione, rinomina/riordino ed eliminazione (le stanze restano,
 *   senza piano);
 * - associazione delle stanze al piano attivo, con posizionamento automatico
 *   nella prima cella libera per non sovrapporre i blocchi;
 * - griglia interattiva con celle guida e snap-to-grid per **spostare** e
 *   **ridimensionare** le stanze (drag del blocco, drag dell'angolo);
 * - marker dei dispositivi trascinabili dentro il perimetro della stanza;
 * - "Salva layout" → `PUT /api/floors/:id/layout` in una transazione, poi
 *   notifica MQTT a tutti i pannelli.
 */
export function FloorplanEditor({ className }: { className?: string }) {
  const { t } = useTranslation('floorplan');
  const pushToast = useToastStore((state) => state.push);
  const { data, isPending, isError } = useFloorplanQuery();
  const rooms = useRooms();
  const devices = useDevices();
  const createFloor = useCreateFloor();
  const updateFloor = useUpdateFloor();
  const deleteFloor = useDeleteFloor();
  const saveLayout = useSaveFloorLayout();

  const floors = useMemo(() => data ?? [], [data]);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const activeFloor = useMemo(
    () => floors.find((floor) => floor.id === selectedFloorId) ?? floors[0],
    [floors, selectedFloorId],
  );
  const activeFloorId = activeFloor?.id ?? null;

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Nuovo piano
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState('0');
  // Rinomina piano attivo
  const [floorName, setFloorName] = useState('');
  const [floorLevel, setFloorLevel] = useState('0');

  const devicesByRoom = useMemo(() => {
    const map = new Map<string, EditorDevice[]>();
    for (const device of devices) {
      const list = map.get(device.room) ?? [];
      list.push({
        id: device.id,
        name: device.name,
        kind: device.kind,
        pin: normalizePinPosition(device.roomPinPosition ?? DEFAULT_PIN_POSITION),
      });
      map.set(device.room, list);
    }
    return map;
  }, [devices]);

  const setDirtyFlag = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };

  // Inizializza la bozza del piano attivo. Il reset avviene solo cambiando
  // piano o quando arriva una topologia nuova **senza modifiche in corso**:
  // un refetch non deve cancellare ciò che l'amministratore sta trascinando.
  useEffect(() => {
    if (!activeFloor) {
      setEditor(null);
      return;
    }
    if (dirtyRef.current) return;
    setEditor(buildEditorState(activeFloor, devicesByRoom));
    setDeletePending(false);
    setError(null);
  }, [activeFloor, devicesByRoom]);

  useEffect(() => {
    if (!activeFloor) return;
    setFloorName(activeFloor.name);
    setFloorLevel(String(activeFloor.levelOrder));
  }, [activeFloor?.id, activeFloor?.name, activeFloor?.levelOrder]);

  const editorRooms = editor?.rooms ?? [];
  const editorRoomIds = useMemo(
    () => new Set(editorRooms.map((room) => room.id)),
    [editorRooms],
  );
  const availableRooms = useMemo(
    () => rooms.filter((room) => !editorRoomIds.has(room.id)),
    [rooms, editorRoomIds],
  );

  const updateRoomLayout = (roomId: string, layout: RoomGridLayout) => {
    setEditor((current) =>
      current
        ? {
            ...current,
            rooms: current.rooms.map((room) =>
              room.id === roomId ? { ...room, layout } : room,
            ),
          }
        : current,
    );
    setDirtyFlag(true);
  };

  const updatePin = (deviceId: string, position: DevicePinPosition) => {
    setEditor((current) =>
      current
        ? {
            ...current,
            rooms: current.rooms.map((room) => ({
              ...room,
              devices: room.devices.map((device) =>
                device.id === deviceId ? { ...device, pin: position } : device,
              ),
            })),
          }
        : current,
    );
    setDirtyFlag(true);
  };

  /** Aggiunge una stanza al piano, collocandola nella prima cella libera. */
  const addRoom = (roomId: string) => {
    const room = rooms.find((candidate) => candidate.id === roomId);
    if (!room) return;
    setEditor((current) => {
      if (!current) return current;
      // Posizione automatica: una stanza che arriva da un altro piano non
      // deve coprire quelle già presenti.
      const layout = firstFreeLayout(current.rooms.map((item) => item.layout));
      return {
        ...current,
        rooms: [
          ...current.rooms,
          {
            id: room.id,
            label: room.label,
            layout,
            devices: devicesByRoom.get(room.id) ?? [],
            originFloorId: room.floorId ?? null,
          },
        ],
        removed: current.removed.filter((item) => item.id !== roomId),
      };
    });
    setDirtyFlag(true);
  };

  const removeRoom = (roomId: string) => {
    setEditor((current) => {
      if (!current) return current;
      const room = current.rooms.find((item) => item.id === roomId);
      if (!room) return current;
      return {
        ...current,
        rooms: current.rooms.filter((item) => item.id !== roomId),
        // Solo una stanza che era davvero su questo piano viene "unassigned".
        // Una appena aggiunta da un altro piano torna semplicemente al suo.
        removed:
          room.originFloorId === current.floorId
            ? [...current.removed, room]
            : current.removed,
      };
    });
    setDirtyFlag(true);
  };

  const save = () => {
    if (!editor) return;
    setError(null);
    const payload: FloorLayoutPayload = {
      rooms: [
        ...editor.rooms.map((room) => ({
          id: room.id,
          floorId: editor.floorId,
          gridLayout: room.layout,
        })),
        ...editor.removed.map((room) => ({
          id: room.id,
          floorId: null,
          gridLayout: room.layout,
        })),
      ],
      devices: editor.rooms.flatMap((room) =>
        room.devices.map((device) => ({
          id: device.id,
          roomPinPosition: device.pin,
        })),
      ),
    };

    saveLayout.mutate(
      { id: editor.floorId, payload },
      {
        onSuccess: () => {
          setDirtyFlag(false);
          pushToast({
            title: t('editor.saved'),
            description: t('editor.savedDescription'),
            tone: 'success',
          });
        },
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : t('editor.saveError')),
      },
    );
  };

  const createNewFloor = () => {
    setError(null);
    const name = newName.trim();
    if (name.length === 0) return;
    createFloor.mutate(
      { name, levelOrder: Number(newLevel) || 0 },
      {
        onSuccess: (floor) => {
          setNewName('');
          setSelectedFloorId(floor.id);
          setDirtyFlag(false);
          pushToast({ title: t('editor.floorCreated'), description: floor.name, tone: 'success' });
        },
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : t('editor.error')),
      },
    );
  };

  const renameActiveFloor = () => {
    if (!activeFloor) return;
    setError(null);
    updateFloor.mutate(
      {
        id: activeFloor.id,
        payload: {
          name: floorName.trim() || activeFloor.name,
          levelOrder: Number(floorLevel) || 0,
          icon: activeFloor.icon,
        },
      },
      {
        onSuccess: () =>
          pushToast({
            title: t('editor.floorUpdated'),
            description: floorName.trim() || activeFloor.name,
            tone: 'success',
          }),
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : t('editor.error')),
      },
    );
  };

  const confirmDeleteFloor = () => {
    if (!activeFloor) return;
    setError(null);
    deleteFloor.mutate(activeFloor.id, {
      onSuccess: () => {
        setDeletePending(false);
        setSelectedFloorId(null);
        setDirtyFlag(false);
        pushToast({
          title: t('editor.floorDeleted'),
          description: activeFloor.name,
          tone: 'success',
        });
      },
      onError: (cause) =>
        setError(cause instanceof Error ? cause.message : t('editor.error')),
    });
  };

  if (isPending) {
    return <p className={cn('text-xs text-fg-subtle', className)}>{t('editor.loading')}</p>;
  }

  if (isError) {
    return (
      <p
        role="alert"
        className={cn(
          'rounded-2xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger',
          className,
        )}
      >
        {t('editor.loadError')}
      </p>
    );
  }

  if (floors.length === 0) {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
          {t('editor.noFloors')}
        </p>
        <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-panel p-4">
          <Field label={t('editor.floorName')}>
            <Input
              value={newName}
              maxLength={128}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Piano terra"
            />
          </Field>
          <Field label={t('editor.levelOrder')}>
            <Input
              type="number"
              min={-99}
              max={999}
              value={newLevel}
              onChange={(event) => setNewLevel(event.target.value)}
              className="w-24"
            />
          </Field>
          <Button
            type="button"
            variant="primary"
            onClick={createNewFloor}
            disabled={newName.trim().length === 0 || createFloor.isPending}
          >
            <Plus className="size-4" /> {t('editor.create')}
          </Button>
        </div>
        <FormError message={error} />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <Layers className="size-4 text-accent" /> {t('editor.title')}
        </p>
        <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-fg-subtle">
          {t('editor.description')}
        </p>
      </div>

      {/* Piani: selezione, rinomina, eliminazione */}
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-40 flex-col gap-1.5">
            <Label>{t('editor.floors')}</Label>
            <select
              className={selectClass}
              value={activeFloorId ?? ''}
              onChange={(event) => {
                setDirtyFlag(false);
                setSelectedFloorId(event.target.value);
              }}
            >
              {floors.map((floor) => (
                <option key={floor.id} value={floor.id}>
                  {floor.name} · {floor.rooms.length}
                </option>
              ))}
            </select>
          </label>
          <Field label={t('editor.floorName')}>
            <Input
              value={floorName}
              maxLength={128}
              onChange={(event) => setFloorName(event.target.value)}
            />
          </Field>
          <Field label={t('editor.levelOrder')}>
            <Input
              type="number"
              min={-99}
              max={999}
              value={floorLevel}
              onChange={(event) => setFloorLevel(event.target.value)}
              className="w-24"
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            onClick={renameActiveFloor}
            disabled={updateFloor.isPending}
          >
            <Save className="size-4" /> {t('editor.saveName')}
          </Button>

          {deletePending ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-danger">
                {t('editor.deleteConfirm', { name: activeFloor?.name ?? '' })}
              </span>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={confirmDeleteFloor}
                disabled={deleteFloor.isPending}
              >
                <Check className="size-4" /> {t('editor.confirm')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDeletePending(false)}
              >
                {t('editor.cancel')}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="danger"
              onClick={() => setDeletePending(true)}
              disabled={deleteFloor.isPending}
            >
              <Trash2 className="size-4" /> {t('editor.delete')}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label={t('editor.addFloor')}>
            <Input
              value={newName}
              maxLength={128}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Secondo piano"
            />
          </Field>
          <Field label={t('editor.levelOrder')}>
            <Input
              type="number"
              min={-99}
              max={999}
              value={newLevel}
              onChange={(event) => setNewLevel(event.target.value)}
              className="w-24"
            />
          </Field>
          <Button
            type="button"
            variant="primary"
            onClick={createNewFloor}
            disabled={newName.trim().length === 0 || createFloor.isPending}
          >
            <Plus className="size-4" /> {t('editor.create')}
          </Button>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[11px] leading-relaxed text-fg-subtle">
          {t('editor.gridHint')}
        </p>
        <div className="flex items-center gap-2">
          <Badge variant={dirty ? 'warning' : 'outline'}>
            {dirty ? t('editor.dirty') : t('editor.clean')}
          </Badge>
          <Button
            type="button"
            variant="primary"
            onClick={save}
            disabled={!dirty || saveLayout.isPending}
          >
            <Save className="size-4" />
            {saveLayout.isPending ? t('editor.saving') : t('editor.save')}
          </Button>
        </div>
      </div>

      <FormError message={error} />

      {/* Griglia interattiva */}
      <div
        role="group"
        aria-label={t('editor.gridAria')}
        className="relative w-full touch-none select-none overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel/40 p-2"
        style={{ aspectRatio: '16 / 10' }}
      >
        {/* Celle guida su un livello separato: se stessero nella stessa grid
            dei blocchi, l'auto-placement salterebbe le celle occupate e
            creerebbe righe implicite fuori dall'aspect ratio. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 grid grid-cols-[repeat(12,minmax(0,1fr))] grid-rows-[repeat(8,minmax(0,1fr))] gap-1"
        >
          {Array.from({ length: FLOORPLAN_GRID.cols * FLOORPLAN_GRID.rows }, (_, index) => (
            <span key={index} className="rounded-md border border-dashed border-line/50" />
          ))}
        </div>

        <div
          ref={gridRef}
          className="relative grid h-full w-full grid-cols-[repeat(12,minmax(0,1fr))] grid-rows-[repeat(8,minmax(0,1fr))] gap-1"
        >
          {(editor?.rooms ?? []).map((room) => (
            <EditorRoomBlock
              key={room.id}
              room={room}
              gridRef={gridRef}
              onLayout={updateRoomLayout}
              onPin={updatePin}
              onRemove={removeRoom}
            />
          ))}
        </div>

        {editorRooms.length === 0 ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-fg-subtle">
            {t('editor.noRooms')}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-panel p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            {t('editor.roomsHere')}
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {editorRooms.length === 0 ? (
              <li className="text-[11px] text-fg-subtle">{t('editor.noRooms')}</li>
            ) : (
              editorRooms.map((room) => (
                <li
                  key={room.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-fg">
                      {room.label}
                    </span>
                    <span className="tabular block text-[10px] text-fg-subtle">
                      {room.layout.col},{room.layout.row} · {room.layout.colSpan}×
                      {room.layout.rowSpan} · {room.devices.length}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      className="h-9 rounded-lg border border-line bg-panel px-2 text-[11px] text-fg"
                      value={room.layout.color}
                      onChange={(event) =>
                        updateRoomLayout(room.id, {
                          ...room.layout,
                          color: event.target.value as RoomColor,
                        })
                      }
                      aria-label={`${room.label}: colore`}
                    >
                      {ROOM_COLORS.map((color) => (
                        <option key={color} value={color}>
                          {color}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t('editor.removeRoom')}: ${room.label}`}
                      onClick={() => removeRoom(room.id)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="rounded-2xl border border-line bg-panel p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            {t('editor.availableRooms')}
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {availableRooms.length === 0 ? (
              <li className="text-[11px] text-fg-subtle">—</li>
            ) : (
              availableRooms.map((room) => (
                <li
                  key={room.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-fg">
                      {room.label}
                    </span>
                    <span className="block text-[10px] text-fg-subtle">
                      {room.floorId ? room.floorId : t('editor.unassigned')}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => addRoom(room.id)}
                  >
                    <Plus className="size-4" /> {t('editor.addRoom')}
                  </Button>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>

      <p className="flex items-center gap-2 text-[10px] text-fg-subtle">
        <Building2 className="size-3.5" />
        {t('editor.gridHint')}
      </p>
    </div>
  );
}
