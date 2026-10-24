import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useDevice, useRoomLabel } from '@/hooks/useDevice';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { useOfflineQueue } from '@/mqtt/offlineQueue';
import { useHomeStore } from '@/store/homeStore';
import { CameraCard } from './CameraCard';
import { ClimateCard } from './ClimateCard';
import { LightCard } from './LightCard';
import { MediaCard } from './MediaCard';
import { PowerCard } from './PowerCard';
import { SensorTile } from './SensorTile';

interface DeviceCardProps {
  /** Solo l'id: le card vicine non ricevono né metadati né telemetria. */
  deviceId: string;
  showFavorite?: boolean;
  className?: string;
}

/**
 * Smista l'entità normalizzata verso il widget corretto.
 *
 * - I metadati arrivano da TanStack Query (referenza stabile finché la
 *   topologia non cambia).
 * - La telemetria arriva da `useDevice`, che osserva solo `deviceStates[id]`.
 * - `memo` + `deviceId` impediscono al parent di ridisegnare la card quando
 *   arriva un messaggio destinato a un altro device.
 */
export const DeviceCard = memo(function DeviceCard({
  deviceId,
  showFavorite = false,
  className,
}: DeviceCardProps) {
  const { t } = useTranslation('devices');
  const { sendAction } = useMqttApi();
  const requestPin = usePinGuard();
  const toggleFavorite = useHomeStore((state) => state.toggleFavorite);
  const device = useDevice(deviceId);
  const roomName = useRoomLabel(device?.room ?? '');
  // Booleano primitivo: il widget si ridisegna solo quando cambia lo stato di
  // sincronizzazione, non a ogni comando in coda su altri device.
  const pending = useOfflineQueue((state) =>
    state.commands.some((command) => command.deviceId === deviceId),
  );

  if (!device) return null;

  const favorite = showFavorite
    ? () => {
        toggleFavorite(device.id);
      }
    : undefined;

  const onAction = (action: Parameters<typeof sendAction>[1]) => {
    if (device.protected) {
      requestPin({
        title: t('guard.title'),
        description: t('guard.description', { name: device.name }),
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
          roomName={roomName}
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
          roomName={roomName}
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
    case 'camera':
      return (
        <CameraCard
          device={device}
          roomName={roomName}
          {...(favorite ? { onToggleFavorite: favorite } : {})}
          {...(className ? { className } : {})}
        />
      );
  }
});
