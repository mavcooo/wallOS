import { Lightbulb, Power, RadioTower } from 'lucide-react';
import type { ReactNode } from 'react';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { DeviceCard } from '@/components/widgets/DeviceCard';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Device, RoomId } from '@/types/device';

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

function groupByKind(devices: Device[]) {
  return {
    lights: devices.filter((device) => device.kind === 'light'),
    climates: devices.filter((device) => device.kind === 'climate'),
    powers: devices.filter((device) => device.kind === 'power'),
    media: devices.filter((device) => device.kind === 'media'),
    sensors: devices.filter((device) => device.kind === 'sensor'),
  };
}

export function RoomsPage() {
  const room = useHomeStore((state) => state.ui.room);
  const setRoom = useHomeStore((state) => state.setRoom);
  const devices = useHomeStore((state) => state.devices);
  const requestPin = usePinGuard();
  const { sendAction } = useMqttApi();
  const user = useCurrentUser();

  // Stanze dinamiche: seed statico + aree scoperte via HA Discovery.
  const allRooms = useHomeStore((state) => state.rooms);
  const rooms = user.allowedRooms
    ? allRooms.filter((candidate) => user.allowedRooms?.includes(candidate.id))
    : allRooms;
  const active = rooms.find((candidate) => candidate.id === room) ?? rooms[0];

  if (!active) {
    return (
      <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">
        Nessuna stanza abilitata per questo profilo.
      </p>
    );
  }

  const roomDevices = Object.values(devices).filter((device) => device.room === active.id);
  const { lights, climates, powers, media, sensors } = groupByKind(roomDevices);
  const online = roomDevices.filter((device) => device.availability === 'online').length;

  const turnOffLights = () => {
    for (const light of lights) sendAction(light.id, { type: 'power', on: false });
  };

  const guardAndTurnOff = () => {
    if (lights.some((light) => light.protected)) {
      requestPin({
        title: 'Spegni luci stanza',
        description: `Conferma lo spegnimento delle luci in ${active.label}.`,
        onConfirm: turnOffLights,
      });
      return;
    }
    turnOffLights();
  };

  const lightsOn = lights.filter((light) => light.kind === 'light' && light.state.on).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs
          value={active.id}
          onValueChange={(value) => setRoom(value as RoomId)}
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
          <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-[10px] text-fg-subtle">
            {online}/{roomDevices.length} online
          </span>
          {lights.length > 0 ? (
            <button
              type="button"
              onClick={guardAndTurnOff}
              disabled={lightsOn === 0}
              className="flex h-10 items-center gap-2 rounded-xl border border-line bg-panel px-3 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
            >
              <Lightbulb className="size-3.5" />
              Spegni luci
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {roomDevices.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">
            Nessun dispositivo configurato in {active.label}.
          </p>
        ) : null}

        {climates.length > 0 ? (
          <Group title="Clima e termostato" count={climates.length}>
            <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
              {climates.map((device) => (
                <DeviceCard key={device.id} device={device} showFavorite />
              ))}
            </div>
          </Group>
        ) : null}

        {lights.length > 0 ? (
          <Group title="Luci" count={lights.length}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {lights.map((device) => (
                <DeviceCard key={device.id} device={device} showFavorite />
              ))}
            </div>
          </Group>
        ) : null}

        {powers.length > 0 ? (
          <Group title="Prese e carichi" count={powers.length}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {powers.map((device) => (
                <DeviceCard key={device.id} device={device} showFavorite />
              ))}
            </div>
          </Group>
        ) : null}

        {media.length > 0 ? (
          <Group title="Media" count={media.length}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {media.map((device) => (
                <DeviceCard key={device.id} device={device} showFavorite />
              ))}
            </div>
          </Group>
        ) : null}

        {sensors.length > 0 ? (
          <Group title="Sensori ambientali" count={sensors.length}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {sensors.map((device) => (
                <DeviceCard key={device.id} device={device} />
              ))}
            </div>
          </Group>
        ) : null}

        {roomDevices.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel/60 px-4 py-3 text-[10px] text-fg-subtle">
            <span className="flex items-center gap-1.5">
              <RadioTower className="size-3.5" /> Adapter attivi:{' '}
              {[...new Set(roomDevices.map((device) => device.adapter))].join(' · ')}
            </span>
            <span className="flex items-center gap-1.5">
              <Power className="size-3.5" /> Topic: {roomDevices[0]?.topics.state}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
