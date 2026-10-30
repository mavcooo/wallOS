import {
  Camera,
  Loader2,
  Pause,
  PictureInPicture2,
  RefreshCw,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { activeLocale } from '@/i18n';
import { useCameraStream } from '@/hooks/useCameraStream';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import type { CameraDevice } from '@/types/device';

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function CameraModalContent({
  device,
  onOpenChange,
}: {
  device: CameraDevice;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('devices');
  const dimmed = useHomeStore((state) => state.ui.screenDimmed);
  const stream = device.stream;
  const camera = useCameraStream({
    streamUrl: stream.url,
    snapshotUrl: stream.snapshotUrl,
    protocol: stream.protocol,
    enabled: !dimmed,
  });
  const [muted, setMuted] = useState(true);
  const [pipActive, setPipActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const offline =
    device.availability === 'offline' || camera.status === 'error' || !stream.url;
  const pipSupported =
    typeof document !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    document.pictureInPictureEnabled === true;

  useEffect(() => {
    const video = camera.videoRef.current;
    if (!video) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    video.addEventListener('enterpictureinpicture', onEnter);
    video.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter);
      video.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, [camera.videoRef, camera.status, camera.transport]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (camera.status !== 'live') return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [camera.status]);

  const toggleMute = () => {
    const video = camera.videoRef.current;
    const next = !muted;
    setMuted(next);
    if (video) video.muted = next;
  };

  const saveSnapshot = async () => {
    const video = camera.videoRef.current;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, 'image/png');
          });
          if (blob) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            downloadBlob(blob, `${device.id}-${stamp}.png`);
            setNotice(t('camera.snapshotSaved'));
            return;
          }
        }
      } catch {
        // Canvas taint/decodifica: si prova lo snapshot HTTP qui sotto.
      }
    }

    const fallback = camera.imageUrl ?? stream.snapshotUrl;
    if (fallback) {
      const link = document.createElement('a');
      link.href = fallback;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
      setNotice(t('camera.snapshotSaved'));
      return;
    }
    setNotice(t('camera.snapshotUnavailable'));
  };

  const requestPip = async () => {
    const video = camera.videoRef.current;
    if (!video || !pipSupported) {
      setNotice(t('camera.pipUnsupported'));
      return;
    }
    try {
      await video.requestPictureInPicture();
    } catch {
      setNotice(t('camera.pipUnsupported'));
    }
  };

  const statusLabel =
    camera.status === 'live' && !offline
      ? t('camera.live')
      : offline
        ? t('camera.offline')
        : camera.status === 'reconnecting'
          ? t('camera.reconnecting')
          : camera.status === 'suspended'
            ? t('camera.suspended')
            : t('camera.connecting');

  return (
    <DialogContent
      showClose={false}
      className="max-h-[94dvh] w-[min(96vw,90rem)] overflow-hidden border-line/80 bg-black p-0"
    >
      <DialogTitle className="sr-only">{device.name}</DialogTitle>
      <DialogDescription className="sr-only">
        {t('camera.openAria', { name: device.name })}
      </DialogDescription>

      <div className="relative flex h-[min(82dvh,calc(100dvh-4rem))] w-full flex-col bg-black">
        <div ref={camera.containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
          <video
            ref={camera.videoRef}
            className={cn(
              'absolute inset-0 size-full object-contain',
              camera.imageUrl && 'hidden',
            )}
            muted={muted}
            playsInline
            autoPlay
            preload="none"
            aria-label={device.name}
          />
          {camera.imageUrl ? (
            <img
              src={camera.imageUrl}
              alt={device.name}
              className="absolute inset-0 size-full object-contain"
              onLoad={camera.handleImageLoad}
              onError={camera.handleImageError}
              draggable={false}
            />
          ) : camera.transport === null && camera.status !== 'suspended' ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Camera className="size-10 text-fg-subtle" aria-hidden />
            </div>
          ) : null}

          {camera.status === 'connecting' || camera.status === 'reconnecting' ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
              <Loader2 className="size-8 animate-spin text-white/85" aria-hidden />
            </div>
          ) : camera.status === 'suspended' ? (
            // Standby kiosk: pausa, non un caricamento in corso.
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
              data-testid="camera-modal-paused"
            >
              <Pause className="size-8 text-white/85" aria-hidden />
            </div>
          ) : null}

          {offline ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
              <WifiOff className="size-9 text-danger" aria-hidden />
              <p className="text-base font-medium text-white">{t('camera.error')}</p>
              <button
                type="button"
                onClick={camera.retry}
                className="flex h-12 items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-5 text-sm font-medium text-white transition-colors hover:bg-white/20"
              >
                <RefreshCw className="size-4" aria-hidden />
                {t('camera.retry')}
              </button>
            </div>
          ) : null}

          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 bg-gradient-to-b from-black/75 via-black/30 to-transparent p-3 sm:p-4">
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-white">{device.name}</p>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider',
                    camera.status === 'live' && !offline
                      ? 'border-success/40 bg-success/20 text-success'
                      : offline
                        ? 'border-danger/40 bg-danger/20 text-danger'
                        : 'border-white/20 bg-black/50 text-white/80',
                  )}
                  aria-live="polite"
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      camera.status === 'live' && !offline
                        ? 'animate-pulse bg-success'
                        : offline
                          ? 'bg-danger'
                          : 'bg-white/70',
                    )}
                    aria-hidden
                  />
                  {statusLabel}
                </span>
                {camera.transport ? (
                  <span className="rounded-full border border-white/15 bg-black/45 px-2 py-1 text-[10px] font-medium text-white/70">
                    {t(`camera.mode.${camera.transport}`)}
                  </span>
                ) : null}
                <span className="tabular text-[11px] text-white/60">
                  {new Intl.DateTimeFormat(activeLocale(), {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  }).format(clock)}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="pointer-events-auto flex size-12 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white transition-colors hover:bg-white/20"
              aria-label={t('camera.close')}
            >
              <X className="size-6" aria-hidden />
            </button>
          </div>

          {notice ? (
            <div
              role="status"
              className="pointer-events-none absolute bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-white/15 bg-black/80 px-4 py-2.5 text-xs font-medium text-white"
            >
              {notice}
            </div>
          ) : null}

          <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-3 sm:p-4">
            <button
              type="button"
              onClick={toggleMute}
              className="flex size-12 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white transition-colors hover:bg-white/20"
              aria-label={t(muted ? 'camera.unmute' : 'camera.mute')}
              title={t(muted ? 'camera.unmute' : 'camera.mute')}
            >
              {muted ? (
                <VolumeX className="size-5" aria-hidden />
              ) : (
                <Volume2 className="size-5" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => void saveSnapshot()}
              className="flex size-12 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white transition-colors hover:bg-white/20"
              aria-label={t('camera.snapshot')}
              title={t('camera.snapshot')}
            >
              <Camera className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => void requestPip()}
              disabled={!pipSupported || camera.status !== 'live'}
              className={cn(
                'flex size-12 items-center justify-center rounded-full border transition-colors',
                pipActive
                  ? 'border-accent/50 bg-accent/20 text-accent'
                  : 'border-white/15 bg-black/55 text-white hover:bg-white/20',
                'disabled:opacity-35',
              )}
              aria-label={t('camera.pip')}
              title={pipSupported ? t('camera.pip') : t('camera.pipUnsupported')}
            >
              <PictureInPicture2 className="size-5" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </DialogContent>
  );
}

export function CameraModal({
  device,
  open,
  onOpenChange,
}: {
  device: CameraDevice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <CameraModalContent device={device} onOpenChange={onOpenChange} /> : null}
    </Dialog>
  );
}
