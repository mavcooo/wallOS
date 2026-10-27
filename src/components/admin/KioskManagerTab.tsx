import { MonitorSmartphone, Radio, Save, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { selectClass } from '@/components/admin/fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useKioskDisplays, useUpdateKiosk } from '@/hooks/useKioskProfile';
import { useRooms } from '@/hooks/useTopologyQuery';
import type { RoomConfig } from '@/lib/rooms';
import { cn, formatRelative } from '@/lib/utils';
import { useToastStore } from '@/store/toastStore';
import {
  KIOSK_DIMMER_LIMITS,
  KIOSK_DISPLAY_DEFAULTS,
  type KioskDisplay,
  type KioskDisplayPatch,
} from '@/types/kiosk';

/** I soli campi modificabili: `id`, timestamp e `online` arrivano dal server. */
function draftOf(display: KioskDisplay): KioskDisplayPatch {
  return {
    name: display.name,
    defaultRoomId: display.defaultRoomId,
    dimmerTimeoutSec: display.dimmerTimeoutSec,
    dimmerScreensaverMode: display.dimmerScreensaverMode,
    performanceMode: display.performanceMode,
    highContrast: display.highContrast,
    pinRequired: display.pinRequired,
    screenOrientation: display.screenOrientation,
    isActive: display.isActive,
  };
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg">{label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-fg-subtle">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/**
 * Scheda di un singolo pannello.
 *
 * Le preferenze sono quelle che fino a ieri vivevano nel localStorage del
 * tablet: qui si modificano da desktop e il salvataggio pubblica la notifica
 * MQTT che il display applica entro un secondo (`useKioskSync`).
 */
function KioskCard({ display, rooms }: { display: KioskDisplay; rooms: readonly RoomConfig[] }) {
  const { t } = useTranslation();
  const update = useUpdateKiosk();
  const pushToast = useToastStore((state) => state.push);

  const [draft, setDraft] = useState<KioskDisplayPatch>(() => draftOf(display));
  const [error, setError] = useState<string | null>(null);

  // Configurazione ricaricata dal server (o salvata da un altro desktop): il
  // form si riallinea. La dipendenza è `updatedAt` e non l'oggetto `display`,
  // che cambia riferimento a ogni refetch dei 30 s e cancellerebbe ciò che
  // l'amministratore sta scrivendo.
  useEffect(() => {
    setDraft(draftOf(display));
    setError(null);
  }, [display.updatedAt, display.id]);

  const patch = (values: KioskDisplayPatch) => setDraft((current) => ({ ...current, ...values }));

  const save = () => {
    setError(null);
    update.mutate(
      { id: display.id, patch: draft },
      {
        onSuccess: () =>
          pushToast({
            title: t('admin.kiosk.saved'),
            description: t('admin.kiosk.savedDescription', { name: draft.name ?? display.name }),
            tone: 'success',
          }),
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : t('admin.kiosk.error')),
      },
    );
  };

  // Ping: ripubblica la configurazione corrente. Il pannello la applica e mostra
  // il toast, quindi è anche la prova che la catena MQTT è viva.
  const push = () => {
    setError(null);
    update.mutate(
      { id: display.id, patch: {} },
      {
        onSuccess: () =>
          pushToast({
            title: t('admin.kiosk.pushed'),
            description: t('admin.kiosk.pushedDescription', { name: display.name }),
            tone: 'success',
          }),
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : t('admin.kiosk.error')),
      },
    );
  };

  const busy = update.isPending;

  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4',
        !display.isActive && 'opacity-70',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
            <MonitorSmartphone className="size-4 shrink-0 text-accent" aria-hidden />
            <span className="truncate">{display.name}</span>
            {display.online ? (
              <Badge variant="success">
                <Wifi className="size-3" /> {t('admin.kiosk.online')}
              </Badge>
            ) : (
              <Badge variant="outline">
                <WifiOff className="size-3" /> {t('admin.kiosk.offline')}
              </Badge>
            )}
            {!display.isActive ? (
              <Badge variant="warning">{t('admin.kiosk.inactive')}</Badge>
            ) : null}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-fg-subtle">
            {display.id} ·{' '}
            {display.lastSeenAt
              ? t('admin.kiosk.lastSeen', { when: formatRelative(display.lastSeenAt) })
              : t('admin.kiosk.neverSeen')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={push}
        >
          <Radio className="size-4" /> {t('admin.kiosk.ping')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <Label>{t('admin.kiosk.name')}</Label>
          <Input
            value={draft.name ?? ''}
            maxLength={128}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <Label>{t('admin.kiosk.room')}</Label>
          <select
            className={selectClass}
            value={draft.defaultRoomId ?? ''}
            onChange={(event) => patch({ defaultRoomId: event.target.value || null })}
          >
            <option value="">{t('admin.kiosk.roomOverview')}</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <Label>{t('admin.kiosk.dimmer')}</Label>
            <span className="tabular text-[11px] text-fg-muted">
              {t('admin.kiosk.dimmerValue', { seconds: draft.dimmerTimeoutSec ?? 120 })}
            </span>
          </div>
          <Slider
            value={[draft.dimmerTimeoutSec ?? KIOSK_DISPLAY_DEFAULTS.dimmerTimeoutSec]}
            min={KIOSK_DIMMER_LIMITS.minSec}
            max={KIOSK_DIMMER_LIMITS.maxSec}
            step={10}
            onValueChange={(values) =>
              patch({
                dimmerTimeoutSec:
                  values[0] ?? KIOSK_DISPLAY_DEFAULTS.dimmerTimeoutSec,
              })
            }
            aria-label={t('admin.kiosk.dimmer')}
          />
          <p className="text-[10px] leading-relaxed text-fg-subtle">
            {t('admin.kiosk.dimmerHint')}
          </p>
        </div>

        <ToggleRow
          label={t('admin.kiosk.performance')}
          hint={t('admin.kiosk.performanceHint')}
          checked={draft.performanceMode ?? false}
          onChange={(value) => patch({ performanceMode: value })}
        />
        <ToggleRow
          label={t('admin.kiosk.contrast')}
          hint={t('admin.kiosk.contrastHint')}
          checked={draft.highContrast ?? false}
          onChange={(value) => patch({ highContrast: value })}
        />
        <ToggleRow
          label={t('admin.kiosk.pin')}
          hint={t('admin.kiosk.pinHint')}
          checked={draft.pinRequired ?? true}
          onChange={(value) => patch({ pinRequired: value })}
        />
        <label className="flex flex-col gap-1.5">
          <Label>{t('admin.kiosk.orientation')}</Label>
          <select
            className={selectClass}
            value={draft.screenOrientation ?? 'landscape'}
            onChange={(event) =>
              patch({
                screenOrientation: event.target.value === 'portrait' ? 'portrait' : 'landscape',
              })
            }
          >
            <option value="landscape">{t('admin.kiosk.landscape')}</option>
            <option value="portrait">{t('admin.kiosk.portrait')}</option>
          </select>
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="primary" size="sm" disabled={busy} onClick={save}>
          <Save className="size-4" /> {busy ? t('admin.kiosk.saving') : t('admin.kiosk.save')}
        </Button>
      </div>
    </article>
  );
}

/**
 * Admin → Display: i tablet a parete registrati, con lo stato di presenza e i
 * parametri hardware modificabili da desktop.
 *
 * La lista si aggiorna ogni 30 s (`useKioskDisplays`): `online` è calcolato dal
 * server sulla base di `last_seen_at`, riscritto a ogni idratazione del pannello.
 */
export function KioskManagerTab() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useKioskDisplays();
  const rooms = useRooms();
  const displays = data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-[11px] leading-relaxed text-fg-subtle">
        {t('admin.kiosk.description')}
      </p>

      {isError ? (
        <p
          role="alert"
          className="rounded-2xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
        >
          {t('admin.kiosk.loadError')}
        </p>
      ) : null}

      {isPending ? (
        <p className="text-xs text-fg-subtle">{t('admin.kiosk.loading')}</p>
      ) : displays.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
          {t('admin.kiosk.empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {displays.map((display) => (
            <KioskCard key={display.id} display={display} rooms={rooms} />
          ))}
        </div>
      )}
    </div>
  );
}
