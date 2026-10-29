import { Camera, Expand, Loader2, RefreshCw, Star, WifiOff } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { activeLocale } from '@/i18n';
import { useCameraStream } from '@/hooks/useCameraStream';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import type { CameraDevice } from '@/types/device';
import { CameraModal } from './CameraModal';

interface CameraCardProps {
  device: CameraDevice;
  roomName: string;
  onToggleFavorite?: () => void;
  className?: string;
}

const LIVE_STATUSES = new Set(['connecting', 'live', 'reconnecting']);

/** Orologio isolato: la card non si ridisegna ogni secondo. */
const CameraClock = memo(function CameraClock({ active }: { active: boolean }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const time = new Intl.DateTimeFormat(activeLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  return <span className="tabular text-[10px] font-medium text-white/80">{time}</span>;
});

function StatusBadge({
  status,
  offline,
}: {
  status: ReturnType<typeof useCameraStream>['status'];
  offline: boolean;
}) {
  const { t } = useTranslation('devices');
  const live = status === 'live' && !offline;
  const error = status === 'error' || offline;
  const label = live
    ? t('camera.live')
    : error
      ? t('camera.offline')
      : status === 'reconnecting'
        ? t('camera.reconnecting')
        : t('camera.connecting');

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-wider backdrop-blur-sm',
        live
          ? 'border-success/40 bg-success/20 text-success'
          : error
            ? 'border-danger/40 bg-danger/20 text-danger'
            : 'border-white/20 bg-black/55 text-white/80',
      )}
      aria-live="polite"
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          live ? 'animate-pulse bg-success' : error ? 'bg-danger' : 'bg-white/70',
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}

export const CameraCard = memo(function CameraCard({
  device,
  roomName,
  onToggleFavorite,
  className,
}: CameraCardProps) {
  const { t } = useTranslation('devices');
  const { t: tCommon } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const dimmed = useHomeStore((state) => state.ui.screenDimmed);
  const stream = device.stream;

  const camera = useCameraStream({
    streamUrl: stream.url,
    snapshotUrl: stream.snapshotUrl,
    protocol: stream.protocol,
    suspended: dimmed || open,
  });

  const offline =
    device.availability === 'offline' || camera.status === 'error' || !stream.url;

  return (
    <>
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel',
          className,
        )}
      >
        <div
          ref={camera.containerRef}
          className="relative w-full overflow-hidden bg-black"
          style={{ aspectRatio: stream.aspectRatio.replace(':', ' / ') }}
        >
          {/* Il <video> resta montato anche in modalità immagine: il ref serve
              al passaggio snapshot → WebRTC senza perdere la prima sessione. */}
          <video
            ref={camera.videoRef}
            className={cn('size-full object-cover', camera.imageUrl && 'hidden')}
            muted
            playsInline
            autoPlay
            preload="none"
            aria-label={device.name}
          />
          {camera.imageUrl ? (
            <img
              src={camera.imageUrl}
              alt={device.name}
              className="absolute inset-0 size-full object-cover"
              onLoad={camera.handleImageLoad}
              onError={camera.handleImageError}
              draggable={false}
            />
          ) : camera.transport === null ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-panel-2">
              <Camera className="size-8 text-fg-subtle" aria-hidden />
            </div>
          ) : null}

          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent p-2.5">
            <StatusBadge status={camera.status} offline={offline} />
            {LIVE_STATUSES.has(camera.status) && !offline ? (
              <CameraClock active={camera.status === 'live'} />
            ) : null}
          </div>

          {camera.status === 'connecting' || camera.status === 'reconnecting' ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35">
              <Loader2 className="size-6 animate-spin text-white/85" aria-hidden />
            </div>
          ) : null}

          {offline ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
              <WifiOff className="size-6 text-danger" aria-hidden />
              <p className="text-xs font-medium text-white">{t('camera.error')}</p>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  camera.retry();
                }}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-3 text-[11px] font-medium text-white transition-colors hover:bg-white/20"
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {t('camera.retry')}
              </button>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setOpen(true)}
            className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            aria-label={t('camera.openAria', { name: device.name })}
          />

          <span className="pointer-events-none absolute bottom-2.5 right-2.5 z-20 flex size-8 items-center justify-center rounded-lg border border-white/15 bg-black/45 text-white/85 backdrop-blur-sm">
            <Expand className="size-3.5" aria-hidden />
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg" title={device.name}>
              {device.name}
            </p>
            <p className="truncate text-[11px] text-fg-subtle">
              {roomName}
              {camera.transport ? ` · ${t(`camera.mode.${camera.transport}`)}` : ''}
            </p>
          </div>
          {onToggleFavorite ? (
            <button
              type="button"
              onClick={onToggleFavorite}
              aria-label={tCommon(device.favorite ? 'favorites.remove' : 'favorites.add')}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl text-fg-subtle transition-colors hover:bg-elevated hover:text-fg"
            >
              <Star className={cn('size-4', device.favorite && 'fill-accent text-accent')} />
            </button>
          ) : null}
        </div>
      </div>

      <CameraModal
        device={device}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
});
