import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useDevice, useRoomLabel } from '@/hooks/useDevice';
import { cn } from '@/lib/utils';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { useOfflineQueue } from '@/mqtt/offlineQueue';
import { selectIsHydrating, useHomeStore } from '@/store/homeStore';
import { AvailabilityBadge } from './AvailabilityBadge';
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
 * - `isAvailable === false` (LWT offline o watchdog `stale`) disabilita il
 *   sottoalbero con `inert` + `pointer-events-none`, mostra il badge e scarta
 *   i comandi: nessuna pubblicazione MQTT verso un device muto.
 * - Durante il Safe Boot (`isHydrating`) il sottoalbero è bloccato allo stesso
 *   modo: l'utente non deve toccare un relè il cui stato retained è in arrivo.
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
  // Booleano primitivo: la card si ridisegna solo a inizio/fine idratazione.
  const hydrating = useHomeStore(selectIsHydrating);

  if (!device) return null;

  const unavailable = device.isAvailable === false;
  const blocked = unavailable || hydrating;

  const favorite = showFavorite
    ? () => {
        toggleFavorite(device.id);
      }
    : undefined;

  const onAction = (action: Parameters<typeof sendAction>[1]) => {
    // Barriera finale: anche un event handler sfuggito a `inert` (o un tap di
    // un widget per cui la card è già disabilitata) non genera comandi a vuoto.
    if (blocked) return;
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

  // Il wrapper è il grid item: la card deve continuare a riempirlo, altrimenti
  // le card della stessa riga perderebbero l'altezza uniforme del layout.
  const card = (() => {
    switch (device.kind) {
      case 'light':
        return (
          <LightCard
            device={device}
            roomName={roomName}
            onAction={onAction}
            pending={pending}
            disabled={unavailable}
            className="h-full"
            {...(favorite ? { onToggleFavorite: favorite } : {})}
          />
        );
      case 'climate':
        return (
          <ClimateCard
            device={device}
            roomName={roomName}
            onAction={onAction}
            pending={pending}
            className="h-full"
            {...(favorite ? { onToggleFavorite: favorite } : {})}
          />
        );
      case 'power':
        return (
          <PowerCard
            device={device}
            onAction={onAction}
            pending={pending}
            className="h-full"
            {...(favorite ? { onToggleFavorite: favorite } : {})}
          />
        );
      case 'media':
        return (
          <MediaCard
            device={device}
            onAction={onAction}
            pending={pending}
            className="h-full"
            {...(favorite ? { onToggleFavorite: favorite } : {})}
          />
        );
      case 'sensor':
        return <SensorTile device={device} className="h-full" />;
      case 'camera':
        return (
          <CameraCard
            device={device}
            roomName={roomName}
            className="h-full"
            {...(favorite ? { onToggleFavorite: favorite } : {})}
          />
        );
    }
  })();

  return (
    <div className={cn('relative h-full', className)}>
      <div
        // `inert` spegne focus, click e slider dell'intero sottoalbero: un solo
        // punto di blocco per tutti i widget, nessun `disabled` da propagare.
        // Vale sia per un device muto sia durante l'idratazione del Safe Boot.
        inert={blocked}
        aria-disabled={blocked || undefined}
        aria-busy={hydrating || undefined}
        className={cn(
          'h-full',
          unavailable && 'pointer-events-none select-none opacity-55 grayscale',
          hydrating && !unavailable && 'pointer-events-none select-none opacity-60',
        )}
      >
        {card}
      </div>
      {unavailable ? (
        <AvailabilityBadge device={device} className="absolute right-2 top-2 z-[1]" />
      ) : null}
    </div>
  );
});
