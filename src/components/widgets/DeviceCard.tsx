import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { useOfflineQueue } from '@/mqtt/offlineQueue';
import { useHomeStore } from '@/store/homeStore';
import type { Device } from '@/types/device';
import { ClimateCard } from './ClimateCard';
import { LightCard } from './LightCard';
import { MediaCard } from './MediaCard';
import { PowerCard } from './PowerCard';
import { SensorTile } from './SensorTile';

interface DeviceCardProps {
  device: Device;
  showFavorite?: boolean;
  className?: string;
}

/** Smista l'entità normalizzata verso il widget corretto. */
export function DeviceCard({ device, showFavorite = false, className }: DeviceCardProps) {
  const { sendAction } = useMqttApi();
  const requestPin = usePinGuard();
  const toggleFavorite = useHomeStore((state) => state.toggleFavorite);
  // Booleano primitivo: il widget si ridisegna solo quando cambia lo stato di
  // sincronizzazione, non a ogni comando in coda su altri device.
  const pending = useOfflineQueue((state) =>
    state.commands.some((command) => command.deviceId === device.id),
  );
  const favorite = showFavorite
    ? () => {
        toggleFavorite(device.id);
      }
    : undefined;

  const onAction = (action: Parameters<typeof sendAction>[1]) => {
    if (device.protected) {
      requestPin({
        title: 'Azione protetta',
        description: `Il comando su ${device.name} richiede il PIN del pannello.`,
        onConfirm: () => sendAction(device.id, action),
      });
      return;
    }
    sendAction(device.id, action);
  };

  switch (device.kind) {
    case 'light':
      return (
        <LightCard
          device={device}
          onAction={onAction}
          pending={pending}
          {...(favorite ? { onToggleFavorite: favorite } : {})}
          {...(className ? { className } : {})}
        />
      );
    case 'climate':
      return (
        <ClimateCard
          device={device}
          onAction={onAction}
          pending={pending}
          {...(favorite ? { onToggleFavorite: favorite } : {})}
          {...(className ? { className } : {})}
        />
      );
    case 'power':
      return (
        <PowerCard
          device={device}
          onAction={onAction}
          pending={pending}
          {...(favorite ? { onToggleFavorite: favorite } : {})}
          {...(className ? { className } : {})}
        />
      );
    case 'media':
      return (
        <MediaCard
          device={device}
          onAction={onAction}
          pending={pending}
          {...(favorite ? { onToggleFavorite: favorite } : {})}
          {...(className ? { className } : {})}
        />
      );
    case 'sensor':
      return <SensorTile device={device} {...(className ? { className } : {})} />;
  }
}
