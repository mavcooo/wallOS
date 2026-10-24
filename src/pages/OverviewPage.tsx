import {
  AlertTriangle,
  Lightbulb,
  PlugZap,
  Thermometer,
  ChevronRight,
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { useMqttApi } from '@/mqtt/MqttProvider';
import { useHomeStore } from '@/store/homeStore';
import { useDevices, useRooms, useScenarios } from '@/hooks/useTopologyQuery';
import { cn, formatTemp, formatWatts } from '@/lib/utils';
import { SummaryCard } from '@/components/widgets/SummaryCard';
import { ScenarioButton } from '@/components/widgets/ScenarioButton';
import { DeviceCard } from '@/components/widgets/DeviceCard';
import type { DeviceMetadata, RoomId } from '@/types/device';
import type { RoomConfig } from '@/lib/rooms';

/** Riferimento condiviso: le stanze senza device non creano array nuovi. */
const NO_DEVICE_IDS: readonly string[] = [];

interface KpiSnapshot {
  lights: number;
  lightsOn: number;
  average: number | null;
  alarms: number;
  alarmName: string | null;
  load: number;
}

/**
 * KPI live in un subtree dedicato: la pagina non si iscrive a `deviceStates`,
 * quindi la griglia e i preferiti non vengono ridisegnati dalla telemetria.
 * Il selettore restituisce solo numeri già arrotondati a ciò che è visibile.
 */
function OverviewKpis({ devices }: { devices: readonly DeviceMetadata[] }) {
  const { t } = useTranslation();
  const kpi = useHomeStore(
    useShallow((state): KpiSnapshot => {
      let lights = 0;
      let lightsOn = 0;
      let load = 0;
      let alarms = 0;
      let alarmName: string | null = null;
      let tempSum = 0;
      let tempCount = 0;

      for (const device of devices) {
        const row = state.deviceStates[device.id];
        if (!row) continue;

        if (row.kind === 'light') {
          lights += 1;
          if (row.state.on) lightsOn += 1;
        } else if (row.kind === 'power') {
          if (row.state.on) load += row.state.watts;
        } else if (row.kind === 'climate') {
          if (row.state.mode !== 'off') {
            tempSum += row.state.currentTemp;
            tempCount += 1;
          }
        } else if (row.kind === 'sensor') {
          if (row.state.type === 'temperature' && typeof row.state.value === 'number') {
            tempSum += row.state.value;
            tempCount += 1;
          }
          if (
            (row.state.type === 'smoke' || row.state.type === 'contact') &&
            row.state.value === true
          ) {
            alarms += 1;
            alarmName ??= device.name;
          }
        }
      }

      return {
        lights,
        lightsOn,
        load: Math.round(load),
        alarms,
        alarmName,
        average: tempCount > 0 ? Number((tempSum / tempCount).toFixed(1)) : null,
      };
    }),
  );

  return (
    <section aria-label={t('overview.statusAria')} className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <SummaryCard
        label={t('overview.kpi.lights.label')}
        value={`${kpi.lightsOn} / ${kpi.lights}`}
        hint={t(kpi.lightsOn > 0 ? 'overview.kpi.lights.hintOn' : 'overview.kpi.lights.hintOff')}
        icon={Lightbulb}
        tone={kpi.lightsOn > 0 ? 'warning' : 'neutral'}
      />
      <SummaryCard
        label={t('overview.kpi.temperature.label')}
        value={kpi.average === null ? '—' : formatTemp(kpi.average)}
        hint={t('overview.kpi.temperature.hint')}
        icon={Thermometer}
        tone="accent"
      />
      <SummaryCard
        label={t('overview.kpi.alarms.label')}
        value={`${kpi.alarms}`}
        hint={
          kpi.alarms === 0
            ? t('overview.kpi.alarms.hintNone')
            : (kpi.alarmName ?? t('overview.kpi.alarms.hintFallback'))
        }
        icon={AlertTriangle}
        tone={kpi.alarms > 0 ? 'danger' : 'neutral'}
      />
      <SummaryCard
        label={t('overview.kpi.load.label')}
        value={formatWatts(kpi.load)}
        hint={t('overview.kpi.load.hint')}
        icon={PlugZap}
        tone={kpi.load > 2500 ? 'danger' : 'neutral'}
      />
    </section>
  );
}

/**
 * Tile stanza: osserva solo le luci della propria stanza. Un cambio di
 * luminosità altrove non la tocca; accendersi/spegnersi di una luce qui sì.
 */
const RoomSummaryButton = memo(function RoomSummaryButton({
  room,
  deviceIds,
}: {
  room: RoomConfig;
  deviceIds: readonly string[];
}) {
  const { t } = useTranslation();
  const setRoom = useHomeStore((state) => state.setRoom);
  const setView = useHomeStore((state) => state.setView);
  const lightsOn = useHomeStore(
    useShallow((state) => {
      let count = 0;
      for (const id of deviceIds) {
        const row = state.deviceStates[id];
        if (row?.kind === 'light' && row.state.on) count += 1;
      }
      return count;
    }),
  );

  return (
    <button
      type="button"
      onClick={() => {
        setRoom(room.id as RoomId);
        setView('rooms');
      }}
      className={cn(
        'flex flex-col items-start gap-1 rounded-2xl border border-line bg-panel px-3 py-3 text-left transition-colors',
        'hover:border-line-strong hover:bg-panel-2',
      )}
    >
      <span className="w-full truncate text-xs font-medium text-fg">{room.label}</span>
      <span className="text-[10px] text-fg-subtle">
        {lightsOn > 0
          ? t('overview.rooms.lightsOn', { count: lightsOn })
          : t('overview.rooms.devices', { count: deviceIds.length })}
      </span>
    </button>
  );
});

/** Preferiti: si iscrive ai soli id con `favorite`, non ai valori. */
function FavoriteDevices() {
  const { t } = useTranslation();
  const favoriteIds = useHomeStore(
    useShallow((state) =>
      Object.values(state.deviceStates)
        .filter((row) => row.favorite)
        .map((row) => row.id)
        .sort(),
    ),
  );

  if (favoriteIds.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
        {t('overview.favorites.empty')}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {favoriteIds.map((deviceId) => (
        <DeviceCard key={deviceId} deviceId={deviceId} showFavorite />
      ))}
    </div>
  );
}

/** Scorciatoia "spegni tutte": compare solo quando c'è almeno una luce accesa. */
function TurnOffAllLights({ lights }: { lights: readonly DeviceMetadata[] }) {
  const { t } = useTranslation();
  const { sendAction } = useMqttApi();
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

  if (lightsOn === 0) return null;

  return (
    <button
      type="button"
      onClick={() => {
        for (const light of lights) sendAction(light.id, { type: 'power', on: false });
      }}
      className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-line bg-panel text-xs font-medium text-fg-muted transition-colors hover:text-fg"
    >
      <Lightbulb className="size-4" />
      {t('overview.turnOffAll', { count: lightsOn })}
    </button>
  );
}

export function OverviewPage() {
  const { t } = useTranslation();
  // Solo metadati: nessuna sottoscrizione alla telemetria a livello pagina.
  const devices = useDevices();
  const rooms = useRooms();
  const scenarios = useScenarios();
  const setView = useHomeStore((state) => state.setView);

  const lights = useMemo(
    () => devices.filter((device) => device.kind === 'light'),
    [devices],
  );
  const devicesByRoom = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const device of devices) {
      const list = map.get(device.room);
      if (list) list.push(device.id);
      else map.set(device.room, [device.id]);
    }
    return map;
  }, [devices]);

  return (
    <div className="flex flex-col gap-5">
      {/* Scenari rapidi */}
      <section aria-labelledby="scenarios-title" className="flex flex-col gap-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 id="scenarios-title" className="text-sm font-semibold text-fg">
              {t('overview.scenarios.title')}
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">
              {t('overview.scenarios.hint', { count: scenarios.length })}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {scenarios.map((scenario) => (
            <ScenarioButton key={scenario.id} scenario={scenario} />
          ))}
        </div>
      </section>

      {/* KPI */}
      <OverviewKpis devices={devices} />

      {/* Stanze */}
      <section aria-labelledby="rooms-title" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 id="rooms-title" className="text-sm font-semibold text-fg">
              {t('overview.rooms.title')}
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">{t('overview.rooms.hint')}</p>
          </div>
          <button
            type="button"
            onClick={() => setView('rooms')}
            className="flex h-9 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg"
          >
            {t('overview.rooms.detail')} <ChevronRight className="size-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {rooms.map((room) => (
            <RoomSummaryButton
              key={room.id}
              room={room}
              deviceIds={devicesByRoom.get(room.id) ?? NO_DEVICE_IDS}
            />
          ))}
        </div>
      </section>

      {/* Preferiti */}
      <section aria-labelledby="favorites-title" className="flex flex-col gap-3">
        <div>
          <h2 id="favorites-title" className="text-sm font-semibold text-fg">
            {t('overview.favorites.title')}
          </h2>
          <p className="mt-0.5 text-[11px] text-fg-subtle">{t('overview.favorites.hint')}</p>
        </div>
        <FavoriteDevices />
      </section>

      <TurnOffAllLights lights={lights} />
    </div>
  );
}
