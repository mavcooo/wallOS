import {
  AlertTriangle,
  Lightbulb,
  PlugZap,
  Thermometer,
  ChevronRight,
} from 'lucide-react';

import { SCENARIOS } from '@/config/scenarios.config';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { useHomeStore } from '@/store/homeStore';
import { cn, formatTemp, formatWatts } from '@/lib/utils';
import { SummaryCard } from '@/components/widgets/SummaryCard';
import { ScenarioButton } from '@/components/widgets/ScenarioButton';
import { DeviceCard } from '@/components/widgets/DeviceCard';
import type { Device } from '@/types/device';

function averageTemperature(devices: Device[]): number | null {
  const temperatures = devices.flatMap((device) => {
    if (device.kind === 'climate' && device.state.mode !== 'off') return [device.state.currentTemp];
    if (device.kind === 'sensor' && device.state.type === 'temperature') {
      return typeof device.state.value === 'number' ? [device.state.value] : [];
    }
    return [];
  });
  if (temperatures.length === 0) return null;
  return temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length;
}

export function OverviewPage() {
  const devices = useHomeStore((state) => state.devices);
  const rooms = useHomeStore((state) => state.rooms);
  const setRoom = useHomeStore((state) => state.setRoom);
  const setView = useHomeStore((state) => state.setView);
  const { sendAction } = useMqttApi();

  const all = Object.values(devices);
  const lights = all.filter((device) => device.kind === 'light');
  const lightsOn = lights.filter((device) => device.kind === 'light' && device.state.on).length;
  const powerDevices = all.filter((device) => device.kind === 'power');
  const currentLoad = powerDevices.reduce(
    (sum, device) => sum + (device.kind === 'power' && device.state.on ? device.state.watts : 0),
    0,
  );
  const alarms = all.filter((device) => {
    if (device.kind !== 'sensor') return false;
    if (device.state.type === 'smoke') return device.state.value === true;
    if (device.state.type === 'contact') return device.state.value === true;
    return false;
  });
  const average = averageTemperature(all);
  const favorites = all.filter((device) => device.favorite);

  return (
    <div className="flex flex-col gap-5">
      {/* Scenari rapidi */}
      <section aria-labelledby="scenarios-title" className="flex flex-col gap-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 id="scenarios-title" className="text-sm font-semibold text-fg">
              Scenari rapidi
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">
              Un tocco, più comandi · {SCENARIOS.length} scene disponibili
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {SCENARIOS.map((scenario) => (
            <ScenarioButton key={scenario.id} scenario={scenario} />
          ))}
        </div>
      </section>

      {/* KPI */}
      <section aria-label="Stato della casa" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryCard
          label="Luci accese"
          value={`${lightsOn} / ${lights.length}`}
          hint={lightsOn > 0 ? 'Illuminazione attiva in casa' : 'Tutte le luci sono spente'}
          icon={Lightbulb}
          tone={lightsOn > 0 ? 'warning' : 'neutral'}
        />
        <SummaryCard
          label="Temperatura media"
          value={average === null ? '—' : formatTemp(average)}
          hint="Media sensori e termostati attivi"
          icon={Thermometer}
          tone="accent"
        />
        <SummaryCard
          label="Allarmi attivi"
          value={`${alarms.length}`}
          hint={alarms.length === 0 ? 'Nessuna anomalia rilevata' : alarms[0]?.name ?? 'Verifica'}
          icon={AlertTriangle}
          tone={alarms.length > 0 ? 'danger' : 'neutral'}
        />
        <SummaryCard
          label="Carico attuale"
          value={formatWatts(currentLoad)}
          hint="Prelievo istantaneo prese smart"
          icon={PlugZap}
          tone={currentLoad > 2500 ? 'danger' : 'neutral'}
        />
      </section>

      {/* Stanze */}
      <section aria-labelledby="rooms-title" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 id="rooms-title" className="text-sm font-semibold text-fg">
              Stanze
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">Accesso rapido agli ambienti</p>
          </div>
          <button
            type="button"
            onClick={() => setView('rooms')}
            className="flex h-9 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg"
          >
            Dettaglio <ChevronRight className="size-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {rooms.map((room) => {
            const inRoom = all.filter((device) => device.room === room.id);
            const on = inRoom.filter(
              (device) => device.kind === 'light' && device.state.on,
            ).length;
            return (
              <button
                key={room.id}
                type="button"
                onClick={() => {
                  setRoom(room.id);
                  setView('rooms');
                }}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-2xl border border-line bg-panel px-3 py-3 text-left transition-colors',
                  'hover:border-line-strong hover:bg-panel-2',
                )}
              >
                <span className="w-full truncate text-xs font-medium text-fg">{room.label}</span>
                <span className="text-[10px] text-fg-subtle">
                  {on > 0 ? `${on} luci accese` : `${inRoom.length} dispositivi`}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Preferiti */}
      <section aria-labelledby="favorites-title" className="flex flex-col gap-3">
        <div>
          <h2 id="favorites-title" className="text-sm font-semibold text-fg">
            Preferiti
          </h2>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            Dispositivi più usati, sempre a portata di mano
          </p>
        </div>
        {favorites.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
            Nessun preferito. Tocca la stella su un dispositivo per aggiungerlo.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {favorites.map((device) => (
              <DeviceCard key={device.id} device={device} showFavorite />
            ))}
          </div>
        )}
      </section>

      {/* Scorciatoia: spegni tutte le luci */}
      {lightsOn > 0 ? (
        <button
          type="button"
          onClick={() => {
            for (const light of lights) sendAction(light.id, { type: 'power', on: false });
          }}
          className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-line bg-panel text-xs font-medium text-fg-muted transition-colors hover:text-fg"
        >
          <Lightbulb className="size-4" />
          Spegni tutte le luci ({lightsOn})
        </button>
      ) : null}
    </div>
  );
}
