import {
  Activity,
  Droplets,
  Flame,
  Gauge,
  Sun,
  Thermometer,
  Wind,
  Zap,
  DoorOpen,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { SensorDevice, SensorType } from '@/types/device';

const ICONS: Record<SensorType, LucideIcon> = {
  temperature: Thermometer,
  humidity: Droplets,
  co2: Wind,
  contact: DoorOpen,
  motion: Activity,
  illuminance: Sun,
  smoke: Flame,
  power: Zap,
  energy: Gauge,
};

interface SensorTileProps {
  device: SensorDevice;
  className?: string;
}

function displayValue(device: SensorDevice): { value: string; unit: string } {
  if (device.state.type === 'smoke') {
    return { value: device.state.value ? 'Allarme' : 'Sicuro', unit: '' };
  }
  if (device.state.type === 'contact') {
    return { value: device.state.value ? 'Aperto' : 'Chiuso', unit: '' };
  }
  if (device.state.type === 'motion') {
    return { value: device.state.value ? 'Movimento' : 'Nessuno', unit: '' };
  }
  const numeric = typeof device.state.value === 'number' ? device.state.value : 0;
  return { value: numeric.toLocaleString('it-IT'), unit: device.state.unit };
}

export function SensorTile({ device, className }: SensorTileProps) {
  const Icon = ICONS[device.state.type];
  const alarm =
    (device.state.type === 'smoke' && device.state.value === true) ||
    (device.state.type === 'contact' && device.state.value === true);
  const { value, unit } = displayValue(device);

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius-card)] border p-4',
        alarm ? 'border-danger/35 bg-danger/5' : 'border-line bg-panel',
        className,
      )}
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl border',
          alarm
            ? 'border-danger/30 bg-danger/10 text-danger'
            : 'border-line bg-panel-2 text-fg-muted',
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] text-fg-subtle">{device.name}</p>
        <p
          className={cn(
            'tabular mt-0.5 truncate text-lg font-medium leading-tight',
            alarm ? 'text-danger' : 'text-fg',
          )}
        >
          {value}
          {unit ? <span className="ml-1 text-xs font-normal text-fg-muted">{unit}</span> : null}
        </p>
      </div>
    </div>
  );
}
