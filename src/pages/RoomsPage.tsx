import { Lightbulb, Power, RadioTower } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { CarouselDots } from '@/components/ui/carousel-dots';
import { VirtualizedDeviceGrid } from '@/components/ui/VirtualizedDeviceGrid';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';
import { useDevices, useRooms } from '@/hooks/useTopologyQuery';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DeviceMetadata, RoomId } from '@/types/device';

function Group({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2.5', className)} aria-label={title}>
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{title}</h3>
        <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] tabular text-fg-subtle">
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

function groupByKind(devices: readonly DeviceMetadata[]) {
  return {
    lights: devices.filter((device) => device.kind === 'light'),
    climates: devices.filter((device) => device.kind === 'climate'),
    powers: devices.filter((device) => device.kind === 'power'),
    media: devices.filter((device) => device.kind === 'media'),
    sensors: devices.filter((device) => device.kind === 'sensor'),
    cameras: devices.filter((device) => device.kind === 'camera'),
  };
}

/** Contatore online isolato: la pagina non osserva la disponibilità dei device. */
const RoomOnlineBadge = memo(function RoomOnlineBadge({
  deviceIds,
}: {
  deviceIds: readonly string[];
}) {
  const { t } = useTranslation();
  const online = useHomeStore(
    useShallow((state) => {
      let count = 0;
      for (const id of deviceIds) {
        if (state.deviceStates[id]?.availability === 'online') count += 1;
      }
      return count;
    }),
  );

  return (
    <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-[10px] text-fg-subtle">
      {t('rooms.online', { online, total: deviceIds.length })}
    </span>
  );
});

/** Spegnimento gruppo: osserva solo le luci della stanza attiva. */
const RoomLightsButton = memo(function RoomLightsButton({
  lights,
  roomLabel,
}: {
  lights: readonly DeviceMetadata[];
  roomLabel: string;
}) {
  const { t } = useTranslation();
  const { sendAction } = useMqttApi();
  const requestPin = usePinGuard();
  const lightsOn = useHomeStore(
    useShallow((state) => {
      let count = 0;
      for (const light of lights) {
        const row = state.deviceStates[light.id];
        if (row?.kind === 'light' && row.state.on) count += 1;
      }
      return count;
    }),
  );

  const turnOffLights = () => {
    for (const light of lights) sendAction(light.id, { type: 'power', on: false });
  };

  const guardAndTurnOff = () => {
    if (lights.some((light) => light.protected)) {
      requestPin({
        title: t('rooms.guardTitle'),
        description: t('rooms.guardDescription', { room: roomLabel }),
        onConfirm: turnOffLights,
      });
      return;
    }
    turnOffLights();
  };

  if (lights.length === 0) return null;

  return (
    <button
      type="button"
      onClick={guardAndTurnOff}
      disabled={lightsOn === 0}
      className="flex h-10 items-center gap-2 rounded-xl border border-line bg-panel px-3 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
    >
      <Lightbulb className="size-3.5" />
      {t('rooms.turnOff')}
    </button>
  );
});

export function RoomsPage() {
  const { t } = useTranslation();
  const room = useHomeStore((state) => state.ui.room);
  const setRoom = useHomeStore((state) => state.setRoom);
  // Metadati e stanze sono server-state: la pagina non si ridisegna con la
  // telemetria, solo le card e i contatori isolati lo fanno.
  const devices = useDevices();
  const allRooms = useRooms();
  const user = useCurrentUser();

  const rooms = user.allowedRooms
    ? allRooms.filter((candidate) => user.allowedRooms?.includes(candidate.id))
    : allRooms;
  const active = rooms.find((candidate) => candidate.id === room) ?? rooms[0];
  const roomIds = useMemo(() => rooms.map((candidate) => candidate.id), [rooms]);
  const activeIndex = active ? rooms.findIndex((candidate) => candidate.id === active.id) : -1;

  // Direzione dell'ultimo swipe: decide da quale lato entra il contenuto.
  const [roomDirection, setRoomDirection] = useState<'left' | 'right' | null>(null);
  // Fine corsa: piccola traslazione elastica invece di cambiare pagina.
  const [edgeNudge, setEdgeNudge] = useState<'start' | 'end' | null>(null);
  const nudgeTimer = useRef<number | null>(null);

  const swipe = useSwipeNavigation<RoomId>({
    items: roomIds,
    current: active?.id ?? roomIds[0] ?? ('' as RoomId),
    onChange: setRoom,
    enabled: rooms.length > 1,
    onSwipe: (direction) => setRoomDirection(direction === 'left' ? 'right' : 'left'),
    onEdge: (edge) => {
      setEdgeNudge(edge);
      if (nudgeTimer.current !== null) window.clearTimeout(nudgeTimer.current);
      nudgeTimer.current = window.setTimeout(() => setEdgeNudge(null), 220);
    },
  });

  useEffect(
    () => () => {
      if (nudgeTimer.current !== null) window.clearTimeout(nudgeTimer.current);
    },
    [],
  );

  const roomDevices = useMemo(
    () => (active ? devices.filter((device) => device.room === active.id) : []),
    [devices, active?.id],
  );
  const groups = useMemo(() => groupByKind(roomDevices), [roomDevices]);
  const roomDeviceIds = useMemo(
    () => roomDevices.map((device) => device.id),
    [roomDevices],
  );
  // Id per gruppo: la griglia virtuale riceve solo stringhe stabili, non i
  // metadati, e non si ridisegna quando arriva telemetria.
  const groupIds = useMemo(
    () => ({
      climates: groups.climates.map((device) => device.id),
      lights: groups.lights.map((device) => device.id),
      powers: groups.powers.map((device) => device.id),
      cameras: groups.cameras.map((device) => device.id),
      media: groups.media.map((device) => device.id),
      sensors: groups.sensors.map((device) => device.id),
    }),
    [groups],
  );

  if (!active) {
    return (
      <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">
        {t('rooms.noneEnabled')}
      </p>
    );
  }

  return (
    <div
      {...swipe.handlers}
      style={{ touchAction: 'pan-y' }}
      className={cn(
        'flex flex-col gap-5 transition-transform duration-200 ease-out motion-reduce:transition-none',
        edgeNudge === 'start' && 'translate-x-1',
        edgeNudge === 'end' && '-translate-x-1',
      )}
      data-testid="rooms-swipe-surface"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs
          value={active.id}
          onValueChange={(value) => {
            setRoomDirection(null);
            setRoom(value as RoomId);
          }}
          className="min-w-0"
        >
          <TabsList className="flex w-full flex-wrap justify-start gap-1 lg:w-auto">
            {rooms.map((candidate) => (
              <TabsTrigger key={candidate.id} value={candidate.id} className="px-3">
                {candidate.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <RoomOnlineBadge deviceIds={roomDeviceIds} />
          <RoomLightsButton lights={groups.lights} roomLabel={active.label} />
        </div>
      </div>

      <CarouselDots
        count={rooms.length}
        activeIndex={activeIndex}
        label={t('swipe.room')}
        onSelect={(index) => {
          const next = rooms[index];
          if (!next) return;
          setRoomDirection(null);
          setRoom(next.id);
        }}
        className="-mt-1"
      />

      <div
        key={active.id}
        className={cn(
          'flex flex-col gap-6 motion-reduce:animate-none',
          roomDirection === 'right' && 'animate-slide-in-right',
          roomDirection === 'left' && 'animate-slide-in-left',
        )}
      >
        {roomDevices.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">
            {t('rooms.empty', { room: active.label })}
          </p>
        ) : null}

        {groups.climates.length > 0 ? (
          <Group title={t('rooms.groups.climate')} count={groups.climates.length}>
            <VirtualizedDeviceGrid
              deviceIds={groupIds.climates}
              columnsCount={{ sm: 1, xl: 2 }}
              estimatedCardHeight={280}
              showFavorite
            />
          </Group>
        ) : null}

        {groups.lights.length > 0 ? (
          <Group title={t('rooms.groups.lights')} count={groups.lights.length}>
            <VirtualizedDeviceGrid
              deviceIds={groupIds.lights}
              columnsCount={{ sm: 1, md: 2, xl: 3 }}
              estimatedCardHeight={240}
              showFavorite
            />
          </Group>
        ) : null}

        {groups.powers.length > 0 ? (
          <Group title={t('rooms.groups.powers')} count={groups.powers.length}>
            <VirtualizedDeviceGrid
              deviceIds={groupIds.powers}
              columnsCount={{ sm: 1, md: 2, xl: 3 }}
              estimatedCardHeight={200}
              showFavorite
            />
          </Group>
        ) : null}

        {groups.cameras.length > 0 ? (
          <Group title={t('rooms.groups.cameras')} count={groups.cameras.length}>
            <VirtualizedDeviceGrid
              deviceIds={groupIds.cameras}
              columnsCount={{ sm: 1, lg: 2, xl: 3 }}
              estimatedCardHeight={360}
              showFavorite
            />
          </Group>
        ) : null}

        {groups.media.length > 0 ? (
          <Group title={t('rooms.groups.media')} count={groups.media.length}>
            <VirtualizedDeviceGrid
              deviceIds={groupIds.media}
              columnsCount={{ sm: 1, md: 2 }}
              estimatedCardHeight={200}
              showFavorite
            />
          </Group>
        ) : null}

        {groups.sensors.length > 0 ? (
          <Group title={t('rooms.groups.sensors')} count={groups.sensors.length}>
            <VirtualizedDeviceGrid
              deviceIds={groupIds.sensors}
              columnsCount={{ sm: 2, xl: 3 }}
              estimatedCardHeight={100}
            />
          </Group>
        ) : null}

        {roomDevices.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel/60 px-4 py-3 text-[10px] text-fg-subtle">
            <span className="flex items-center gap-1.5">
              <RadioTower className="size-3.5" />{' '}
              {t('rooms.adapters', {
                adapters: [...new Set(roomDevices.map((device) => device.adapter))].join(' · '),
              })}
            </span>
            <span className="flex items-center gap-1.5">
              <Power className="size-3.5" /> {t('rooms.topic', { topic: roomDevices[0]?.topics.state })}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
