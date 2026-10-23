import { CloudUpload, Radio, RotateCw, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useOfflineQueue } from '@/mqtt/offlineQueue';
import { useHomeStore } from '@/store/homeStore';
import type { ConnectionStatus } from '@/types/mqtt';

const TONES: Record<ConnectionStatus, string> = {
  idle: 'border-line bg-panel-2 text-fg-muted',
  connecting: 'border-warning/30 bg-warning/10 text-warning',
  connected: 'border-success/30 bg-success/10 text-success',
  reconnecting: 'border-warning/30 bg-warning/10 text-warning',
  offline: 'border-danger/30 bg-danger/10 text-danger',
  error: 'border-danger/30 bg-danger/10 text-danger',
};

export function ConnectionBadge({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { t } = useTranslation();
  const connection = useHomeStore((state) => state.connection);
  const demoMode = useHomeStore((state) => state.broker.demoMode);
  const pending = useOfflineQueue((state) => state.commands.length);
  const status = connection.status;
  const busy = status === 'connecting' || status === 'reconnecting';
  const statusLabel = t(`connection.status.${status}`);

  return (
    <button
      type="button"
      onClick={onOpenSettings}
      className={cn(
        'flex h-12 items-center gap-3 rounded-2xl border px-3 text-left transition-colors',
        TONES[status],
        'hover:brightness-110',
      )}
      aria-label={`${t('connection.aria', { status: statusLabel })}${
        pending > 0 ? ` · ${t('connection.pending', { count: pending })}` : ''
      }`}
    >
      <span className="relative flex size-2.5 shrink-0">
        {busy ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        ) : null}
        <span className="relative inline-flex size-2.5 rounded-full bg-current" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          MQTT · {statusLabel}
          {demoMode ? (
            <span className="rounded bg-current/10 px-1 py-0.5 text-[9px] font-bold uppercase">
              {t('connection.demo')}
            </span>
          ) : null}
          {pending > 0 ? (
            <span
              className="flex items-center gap-1 rounded bg-current/10 px-1 py-0.5 text-[9px] font-bold"
              title={t('connection.pending', { count: pending })}
            >
              <CloudUpload
                className={cn('size-2.5', status === 'connected' && 'animate-pulse')}
                aria-hidden
              />
              <span className="tabular">{pending}</span>
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[10px] font-medium text-fg-muted">
          <span className="tabular">
            {connection.latencyMs === null
              ? t('connection.latencyEmpty')
              : `${connection.latencyMs} ms`}
          </span>
          <span className="text-fg-subtle">·</span>
          <span className="flex items-center gap-1">
            {connection.reconnectAttempts > 0 ? (
              <>
                <RotateCw className="size-2.5" /> {connection.reconnectAttempts}
              </>
            ) : (
              <>
                {status === 'connected' ? (
                  <Radio className="size-2.5" />
                ) : (
                  <WifiOff className="size-2.5" />
                )}
                {t('connection.rx', { count: connection.messagesIn })}
              </>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
