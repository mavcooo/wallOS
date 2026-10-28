import {
  Camera,
  Lightbulb,
  Plug,
  Speaker,
  Thermometer,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useDevice } from '@/hooks/useDevice';
import { isAlarmSensorState } from '@/lib/floorplan';
import { isKioskPinRequired } from '@/lib/kioskPolicy';
import { cn } from '@/lib/utils';
import { useMqttApi } from '@/mqtt/MqttProvider';
import type { ControlAction, DeviceKind } from '@/types/device';
import type { DevicePinPosition } from '@/types/floorplan';

/** Oltre questa pressione continua si apre il dettaglio invece di comandare. */
export const LONG_PRESS_MS = 500;

const ICONS: Record<DeviceKind, LucideIcon> = {
  light: Lightbulb,
  climate: Thermometer,
  power: Plug,
  media: Speaker,
  sensor: Waypoints,
  camera: Camera,
};

interface DeviceMapPinProps {
  deviceId: string;
  /** Coordinate percentuali dentro il riquadro della stanza. */
  pin: DevicePinPosition;
  /** Etichetta di riserva dal payload dei piani, se i metadati non sono pronti. */
  name: string;
  /** Luce/presa/media si comandano al tap; gli altri si aprono al primo tocco. */
  kind: DeviceKind;
  onOpenDetail: (deviceId: string) => void;
  className?: string;
}

/**
 * Marker di un dispositivo nella planimetria.
 *
 * - posizionamento assoluto in percentuale dentro la stanza (`left`/`top`),
 *   quindi identico su ogni tablet;
 * - **tap** → comando immediato via MQTT (l'ottimismo lo applica `sendAction`);
 *   luci, prese e media fanno on/off, clima/sensori/telecamere aprono il
 *   dettaglio perché non hanno un "toggle" sensato;
 * - **pressione prolungata (500 ms)** → modale di regolazione dettagliata;
 * - ogni evento touch viene fermato: il marker non deve innescare swipe di
 *   pagina o selezione della stanza sottostante.
 */
export function DeviceMapPin({
  deviceId,
  pin,
  name,
  kind,
  onOpenDetail,
  className,
}: DeviceMapPinProps) {
  const { t } = useTranslation('floorplan');
  const device = useDevice(deviceId);
  const { sendAction } = useMqttApi();
  const requestPin = usePinGuard();
  const timerRef = useRef<number | null>(null);
  const longPressRef = useRef(false);

  const resolvedKind = device?.kind ?? kind;
  const mode = device?.kind;
  const Icon = ICONS[resolvedKind];
  const unavailable = device ? device.isAvailable === false : false;
  const alarm = device?.kind === 'sensor' && isAlarmSensorState(device.state);

  const isOn =
    (mode === 'light' && device?.state.on) ||
    (mode === 'power' && device?.state.on) ||
    (mode === 'media' && device?.state.power);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Comando immediato (o modale, per i tipi senza on/off). */
  const activate = () => {
    if (!device) return;

    const next = mode === 'light' || mode === 'power' ? !device.state.on : undefined;
    const action: ControlAction | null =
      mode === 'media'
        ? { type: 'power', on: !device.state.power }
        : next === undefined
          ? null
          : { type: 'power', on: next };

    // Clima, sensori e telecamere non hanno un on/off: il tap apre il
    // dettaglio, utile anche per un dispositivo non raggiungibile.
    if (!action) {
      onOpenDetail(device.id);
      return;
    }
    if (unavailable) return;

    if (device.protected && isKioskPinRequired()) {
      requestPin({
        title: t('pin.guardTitle'),
        description: t('pin.guardDescription', { name: device.name }),
        onConfirm: () => sendAction(device.id, action),
      });
      return;
    }
    sendAction(device.id, action);
  };

  const stop = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // Solo il tasto primario del mouse: il tasto destro resta al browser.
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    longPressRef.current = false;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      longPressRef.current = true;
      onOpenDetail(deviceId);
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const wasLongPress = longPressRef.current;
    longPressRef.current = false;
    clearTimer();
    // Dopo il long-press il dito non deve anche accendere il device.
    if (!wasLongPress) activate();
  };

  const status = unavailable
    ? t('pin.unavailable')
    : alarm
      ? t('pin.alarm')
      : isOn
        ? t('pin.on')
        : t('pin.off');

  return (
    <button
      type="button"
      // Il contenitore della stanza non deve ricevere il tap: né swipe, né
      // selezione. `touch-action: none` tiene fermo il long-press anche su iOS.
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={(event) => {
        stop(event);
        longPressRef.current = false;
        clearTimer();
      }}
      onPointerLeave={(event) => {
        stop(event);
        longPressRef.current = false;
        clearTimer();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      aria-label={t('pin.aria', { name: device?.name ?? name, status })}
      title={t('pin.hint')}
      data-device-pin={deviceId}
      data-state={alarm ? 'alarm' : isOn ? 'on' : 'off'}
      style={{
        left: `${pin.x}%`,
        top: `${pin.y}%`,
        touchAction: 'none',
      }}
      className={cn(
        'absolute z-[1] flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center',
        'rounded-full border shadow-md transition-colors active:scale-95 motion-reduce:active:scale-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        alarm
          ? 'border-danger bg-danger/20 text-danger animate-alarm-pulse'
          : isOn
            ? 'border-warning/50 bg-warning/20 text-warning'
            : 'border-line-strong/70 bg-panel/95 text-fg-muted hover:text-fg',
        unavailable && 'pointer-events-none opacity-40 grayscale',
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
