import { Droplets, Lightbulb, ShieldAlert, Thermometer } from 'lucide-react';
import { memo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import {
  ROOM_COLOR_CLASSES,
  isRoomColor,
  isSecurityAlarm,
  roomSignals,
  type RoomSignals,
} from '@/lib/floorplan';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import type { Floor, FloorRoom } from '@/types/floorplan';
import { DeviceMapPin } from './DeviceMapPin';

interface SchematicFloorCanvasProps {
  floor: Floor;
  /** Stanza evidenziata (quella selezionata nelle tab della vista griglia). */
  activeRoomId?: string | null;
  onSelectRoom?: (roomId: string) => void;
  onOpenDetail: (deviceId: string) => void;
  className?: string;
}

/** Percentuali/span → stile della cella nella matrice CSS 12×8. */
function gridStyle(room: FloorRoom): CSSProperties {
  return {
    gridColumn: `${room.gridLayout.col} / span ${room.gridLayout.colSpan}`,
    gridRow: `${room.gridLayout.row} / span ${room.gridLayout.rowSpan}`,
  };
}

function round(value: number, digits = 0): string {
  return value.toFixed(digits).replace(/\.0$/, '');
}

/**
 * Blocco stanza della planimetria.
 *
 * È un componente isolato che osserva **solo** i dispositivi della propria
 * stanza: la telemetria di un'altra stanza non lo ridisegna. Il bagliore ambra
 * compare con almeno una luce accesa, il pulse rosso ad alta frequenza con un
 * sensore di sicurezza in allarme.
 */
const RoomBlock = memo(function RoomBlock({
  room,
  active,
  onSelectRoom,
  onOpenDetail,
}: {
  room: FloorRoom;
  active: boolean;
  onSelectRoom?: (roomId: string) => void;
  onOpenDetail: (deviceId: string) => void;
}) {
  const { t } = useTranslation('floorplan');
  const signals = useHomeStore(
    useShallow((state): RoomSignals => roomSignals(room.devices, state.deviceStates)),
  );

  const colorClass = isRoomColor(room.gridLayout.color)
    ? ROOM_COLOR_CLASSES[room.gridLayout.color]
    : ROOM_COLOR_CLASSES.zinc;

  return (
    <div
      style={gridStyle(room)}
      data-room-block={room.id}
      data-state={signals.alarm ? 'alarm' : signals.lightsOn ? 'lit' : 'idle'}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border p-1.5 transition-colors',
        colorClass,
        signals.alarm && 'border-danger/60 animate-alarm-pulse',
        !signals.alarm && signals.lightsOn && 'border-warning/40',
        active && 'ring-2 ring-accent/50',
      )}
    >
      {/* Bagliore ambra tenue: nessun layout shift, solo un livello di colore. */}
      {signals.lightsOn && !signals.alarm ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(251,191,36,0.16),transparent_70%)]"
        />
      ) : null}

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onSelectRoom?.(room.id);
        }}
        aria-label={t('canvas.selectRoom', { room: room.label })}
        aria-pressed={active}
        className="relative z-[1] flex min-h-9 items-center gap-1.5 self-start rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span className="truncate text-[11px] font-semibold leading-tight text-fg sm:text-xs">
          {room.label}
        </span>
        {signals.alarm ? (
          <ShieldAlert className="size-3.5 shrink-0 text-danger" aria-label={t('canvas.alarm')} />
        ) : null}
        {signals.lightsOn ? (
          <Lightbulb className="size-3.5 shrink-0 text-warning" aria-label={t('canvas.lightOn')} />
        ) : null}
      </button>

      {/* Badge compatto con le medie ambientali, al centro del blocco. */}
      {signals.temperature !== null || signals.humidity !== null ? (
        <div className="pointer-events-none absolute inset-x-1 top-1/2 z-[1] flex -translate-y-1/2 flex-col items-center gap-0.5 text-center">
          {signals.temperature !== null ? (
            <span className="tabular flex items-center gap-1 rounded-full border border-line/70 bg-bg/70 px-2 py-0.5 text-[10px] font-medium text-fg-muted">
              <Thermometer className="size-3 text-heat" aria-hidden="true" />
              {round(signals.temperature, 1)}°C
            </span>
          ) : null}
          {signals.humidity !== null ? (
            <span className="tabular flex items-center gap-1 rounded-full border border-line/70 bg-bg/70 px-2 py-0.5 text-[10px] font-medium text-fg-muted">
              <Droplets className="size-3 text-cool" aria-hidden="true" />
              {round(signals.humidity)}%
            </span>
          ) : null}
        </div>
      ) : null}

      <span className="pointer-events-none absolute bottom-1 left-1.5 z-[1] text-[9px] text-fg-subtle">
        {t('canvas.devices', { count: room.devices.length })}
      </span>

      {/* Marker: coordinate percentuali dentro il riquadro della stanza. */}
      <div className="absolute inset-0 z-[2]">
        {room.devices.map((device) => (
          <DeviceMapPin
            key={device.id}
            deviceId={device.id}
            pin={device.roomPinPosition}
            name={device.name}
            kind={device.kind}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </div>
    </div>
  );
});

/**
 * Canvas generativo della pianta.
 *
 * Matrice CSS 12×8 con `aspect-ratio` 16:10 e celle `minmax(0,1fr)`: le stanze
 * si posizionano da `grid_layout`, senza immagini, file CAD o misure in pixel.
 * Lo sfondo risponde allo store Zustand: bagliore ambra con almeno una luce
 * accesa sul piano, pulse rosso se un sensore di sicurezza è in allarme.
 */
export const SchematicFloorCanvas = memo(function SchematicFloorCanvas({
  floor,
  activeRoomId,
  onSelectRoom,
  onOpenDetail,
  className,
}: SchematicFloorCanvasProps) {
  const { t } = useTranslation('floorplan');
  // Solo due booleani: il canvas si ridisegna al cambio di "acceso/allarme",
  // non a ogni payload di telemetria dei singoli dispositivi.
  const glow = useHomeStore(
    useShallow((state) => {
      let lightsOn = false;
      let alarm = false;
      for (const room of floor.rooms) {
        for (const device of room.devices) {
          const row = state.deviceStates[device.id];
          if (row?.kind === 'light' && row.state.on) lightsOn = true;
          if (isSecurityAlarm(row)) alarm = true;
        }
      }
      return { lightsOn, alarm };
    }),
  );

  return (
    <section
      aria-label={t('canvas.aria', { floor: floor.name })}
      className={cn(
        'relative w-full overflow-hidden rounded-[var(--radius-card)] border transition-colors',
        glow.alarm
          ? 'border-danger/50 bg-bg animate-alarm-pulse'
          : glow.lightsOn
            ? 'border-warning/25 bg-[radial-gradient(circle_at_20%_0%,rgba(251,191,36,0.10),transparent_60%)]'
            : 'border-line bg-panel/40',
        className,
      )}
      style={{ aspectRatio: '16 / 10' }}
      data-floor-alarm={glow.alarm || undefined}
      data-floor-lit={glow.lightsOn || undefined}
    >
      <div
        id="schematic-floor-canvas"
        className="grid h-full w-full grid-cols-[repeat(12,minmax(0,1fr))] grid-rows-[repeat(8,minmax(0,1fr))] gap-1.5 p-2"
      >
        {floor.rooms.map((room) => (
          <RoomBlock
            key={room.id}
            room={room}
            active={room.id === activeRoomId}
            onOpenDetail={onOpenDetail}
            {...(onSelectRoom ? { onSelectRoom } : {})}
          />
        ))}
      </div>

      {floor.rooms.length === 0 ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-fg-subtle">
          {t('floors.noRooms')}
        </p>
      ) : null}
    </section>
  );
});
