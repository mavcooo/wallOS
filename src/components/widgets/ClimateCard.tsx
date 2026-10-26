import {
  CalendarClock,
  Flame,
  Hourglass,
  Minus,
  Palmtree,
  Plus,
  Power,
  RefreshCw,
  Snowflake,
  Star,
  Wind,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useClearClimateOverride,
  useClimateSchedule,
  useClimateVacation,
  useSetClimateOverride,
} from '@/hooks/useClimateSchedule';
import { clamp, cn, formatTemp } from '@/lib/utils';
import type { ClimateOverrideDuration, ClimateOverrideRequest } from '@/types/climate';
import type {
  ClimateAction,
  ClimateDevice,
  ClimateMode,
  ControlAction,
  FanSpeed,
} from '@/types/device';
import { ClimateOverridePrompt } from './ClimateOverridePrompt';
import { ClimateScheduleModal } from './ClimateScheduleModal';
import { SyncIndicator } from './SyncIndicator';

interface ClimateCardProps {
  device: ClimateDevice;
  /** Etichetta stanza risolta dal parent: il widget non legge la topologia. */
  roomName: string;
  onAction: (action: ControlAction) => void;
  onToggleFavorite?: () => void;
  /** Comando in coda, in attesa di conferma dal broker. */
  pending?: boolean;
  className?: string;
}

const RADIUS = 82;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SWEEP = 0.75; // 270°

const MODE_BUTTONS: readonly { mode: ClimateMode; icon: typeof Flame }[] = [
  { mode: 'off', icon: Power },
  { mode: 'heat', icon: Flame },
  { mode: 'cool', icon: Snowflake },
  { mode: 'auto', icon: RefreshCw },
];

const FAN_SPEEDS: readonly FanSpeed[] = ['auto', 'low', 'medium', 'high'];

function accentFor(action: ClimateAction): string {
  if (action === 'heating') return 'text-heat';
  if (action === 'cooling') return 'text-cool';
  if (action === 'fan' || action === 'drying') return 'text-accent';
  return 'text-fg-subtle';
}

export function ClimateCard({
  device,
  roomName,
  onAction,
  onToggleFavorite,
  pending = false,
  className,
}: ClimateCardProps) {
  const { t } = useTranslation('devices');
  const { t: tCommon } = useTranslation('common');
  const { state } = device;
  const [draft, setDraft] = useState(state.targetTemp);
  const [dragging, setDragging] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /** Setpoint in attesa della scelta di durata dell'override. */
  const [overrideDraft, setOverrideDraft] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const draftRef = useRef(state.targetTemp);

  // Programma e override: una sola query per card (condivisa col modale).
  const scheduleQuery = useClimateSchedule(device.id);
  const schedule = scheduleQuery.data;
  const override = schedule?.runtime?.override ?? null;
  const vacation = schedule?.runtime?.vacation ?? null;
  const programmed = (schedule?.schedules.length ?? 0) > 0;
  const setOverride = useSetClimateOverride(device.id);
  const clearOverride = useClearClimateOverride(device.id);
  const stopVacation = useClimateVacation(device.id);

  useEffect(() => {
    if (draggingRef.current) return;
    setDraft(state.targetTemp);
    draftRef.current = state.targetTemp;
  }, [state.targetTemp]);

  const quantize = (value: number) => {
    const stepped = Math.round((value - device.minTemp) / device.tempStep) * device.tempStep;
    return Number(clamp(stepped + device.minTemp, device.minTemp, device.maxTemp).toFixed(1));
  };

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const raw = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    const degrees = (raw + 360) % 360;
    let relative = (degrees - 135 + 360) % 360;
    if (relative > 270) relative = relative > 315 ? 270 : 0;
    const fraction = relative / 270;
    const next = quantize(device.minTemp + fraction * (device.maxTemp - device.minTemp));
    draftRef.current = next;
    setDraft(next);
  };

  /**
   * La temperatura parte subito verso il broker (comando manuale immediato) e
   * l'override viene registrato *nello stesso gesto*: tra il tocco e la scelta
   * della durata c'è un giro del job (fino a 60 s) che altrimenti riallineerebbe
   * il dispositivo al programma. Il prompt poi affina la durata; chiuderlo
   * senza scegliere lascia l'override predefinito (prossimo cambio orario).
   */
  const commit = (value: number) => {
    onAction({ type: 'targetTemp', targetTemp: value });
    if (!programmed || vacation) return;
    setOverrideDraft(value);
    setOverride.mutate({ targetTemp: value, preset: 'comfort', until: 'next_schedule' });
  };

  const chooseOverride = (duration: ClimateOverrideDuration) => {
    if (overrideDraft === null) return;
    const request: ClimateOverrideRequest =
      'minutes' in duration
        ? { targetTemp: overrideDraft, preset: 'comfort', durationMinutes: duration.minutes }
        : { targetTemp: overrideDraft, preset: 'comfort', until: duration.until };
    setOverride.mutate(request, { onSettled: () => setOverrideDraft(null) });
  };

  const clockOf = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const nudge = (delta: number) => {
    const next = quantize(draftRef.current + delta);
    draftRef.current = next;
    setDraft(next);
    commit(next);
  };

  const fraction = (draft - device.minTemp) / (device.maxTemp - device.minTemp);
  const progress = `${fraction * SWEEP * CIRCUMFERENCE} ${CIRCUMFERENCE}`;
  const track = `${SWEEP * CIRCUMFERENCE} ${CIRCUMFERENCE}`;
  const actionTone = accentFor(state.action);
  const off = state.mode === 'off';

  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-panel p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
            {device.name}
            <SyncIndicator pending={pending} />
            {onToggleFavorite ? (
              <button
                type="button"
                onClick={onToggleFavorite}
                aria-label={tCommon(
                  device.favorite ? 'favorites.remove' : 'favorites.add',
                )}
                className="ml-0.5 text-fg-subtle transition-colors hover:text-fg"
              >
                <Star className={cn('size-3.5', device.favorite && 'fill-accent text-accent')} />
              </button>
            ) : null}
          </p>
          <p className="truncate text-[11px] text-fg-subtle">
            {roomName} · {t('climate.humidity', { value: state.humidity ?? '—' })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setScheduleOpen(true)}
            aria-label={t('climate.schedule.openAria', { name: device.name })}
            title={t('climate.schedule.openAria', { name: device.name })}
            className="flex size-9 items-center justify-center rounded-xl border border-line bg-panel-2 text-fg-subtle transition-colors hover:text-fg"
          >
            <CalendarClock className="size-4" />
          </button>
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[10px] font-medium',
              actionTone,
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {off ? t('climate.off') : t(`climate.actions.${state.action}`)}
          </span>
        </div>
      </div>

      {/* Override o vacanza: il programma è sospeso, l'utente deve vederlo
          senza aprire il modale e poterlo annullare con un tocco. */}
      {override ? (
        <div
          role="status"
          className="flex items-center gap-1.5 rounded-xl border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[10px] font-medium text-warning"
        >
          <Hourglass className="size-3 shrink-0" aria-hidden />
          <span className="tabular min-w-0 flex-1 truncate">
            {override.permanent
              ? t('climate.override.badgePermanent', {
                  temp: formatTemp(override.targetTemp),
                })
              : t('climate.override.badge', {
                  temp: formatTemp(override.targetTemp),
                  time: override.until === null ? '—' : clockOf(override.until),
                })}
          </span>
          <button
            type="button"
            onClick={() => clearOverride.mutate()}
            disabled={clearOverride.isPending}
            aria-label={t('climate.override.cancel')}
            title={t('climate.override.cancel')}
            className="flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-warning/20 disabled:opacity-40"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : vacation ? (
        <div
          role="status"
          className="flex items-center gap-1.5 rounded-xl border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[10px] font-medium text-warning"
        >
          <Palmtree className="size-3 shrink-0" aria-hidden />
          <span className="tabular min-w-0 flex-1 truncate">
            {vacation.until === null
              ? t('climate.vacation.noEnd')
              : t('climate.vacation.until', {
                  date: new Date(vacation.until).toLocaleString([], {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })}
          </span>
          <button
            type="button"
            onClick={() => stopVacation.mutate({ active: false, until: null })}
            disabled={stopVacation.isPending}
            aria-label={t('climate.vacation.cancel')}
            title={t('climate.vacation.cancel')}
            className="flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-warning/20 disabled:opacity-40"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        {/* Manopola */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => nudge(-device.tempStep)}
            className="flex size-11 items-center justify-center rounded-full border border-line text-fg-muted transition-colors hover:bg-elevated hover:text-fg active:scale-95"
            aria-label={t('climate.decreaseSetpoint')}
          >
            <Minus className="size-4" />
          </button>

          <div
            role="slider"
            tabIndex={0}
            aria-label={t('climate.setpointAria', { name: device.name })}
            aria-valuemin={device.minTemp}
            aria-valuemax={device.maxTemp}
            aria-valuenow={draft}
            aria-valuetext={`${formatTemp(draft)}`}
            className={cn(
              'ignore-swipe relative size-[172px] touch-none select-none rounded-full outline-none transition-shadow',
              'focus-visible:ring-2 focus-visible:ring-accent/40',
              dragging && 'cursor-grabbing',
            )}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              draggingRef.current = true;
              setDragging(true);
              updateFromPointer(event);
            }}
            onPointerMove={(event) => {
              if (!draggingRef.current) return;
              updateFromPointer(event);
            }}
            onPointerUp={(event) => {
              if (!draggingRef.current) return;
              draggingRef.current = false;
              setDragging(false);
              updateFromPointer(event);
              commit(draftRef.current);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              draggingRef.current = false;
              setDragging(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
                event.preventDefault();
                nudge(device.tempStep);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
                event.preventDefault();
                nudge(-device.tempStep);
              } else if (event.key === 'Home') {
                event.preventDefault();
                nudge(device.minTemp - draftRef.current);
              } else if (event.key === 'End') {
                event.preventDefault();
                nudge(device.maxTemp - draftRef.current);
              }
            }}
          >
            <svg viewBox="0 0 200 200" className="size-full -rotate-0">
              <circle
                cx="100"
                cy="100"
                r={RADIUS}
                fill="none"
                stroke="var(--color-elevated)"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={track}
                transform="rotate(135 100 100)"
              />
              <circle
                cx="100"
                cy="100"
                r={RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={progress}
                transform="rotate(135 100 100)"
                className={cn('transition-[stroke-dasharray] duration-150', actionTone)}
              />
              {/* Tacche ogni 5 °C */}
              {Array.from({ length: 6 }, (_, index) => {
                const value = device.minTemp + index * 5;
                if (value > device.maxTemp) return null;
                const angle = ((135 + ((value - device.minTemp) / (device.maxTemp - device.minTemp)) * 270) * Math.PI) / 180;
                const inner = RADIUS - 16;
                const outer = RADIUS - 22;
                return (
                  <line
                    key={value}
                    x1={100 + Math.cos(angle) * inner}
                    y1={100 + Math.sin(angle) * inner}
                    x2={100 + Math.cos(angle) * outer}
                    y2={100 + Math.sin(angle) * outer}
                    stroke="var(--color-line-strong)"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                );
              })}
            </svg>

            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
                {t('climate.target')}
              </span>
              <span className="tabular mt-0.5 text-5xl font-extralight leading-none text-fg">
                {formatTemp(draft).replace('°', '')}
                <span className="align-top text-lg text-fg-muted">°</span>
              </span>
              <span className="tabular mt-1.5 text-[11px] text-fg-muted">
                {t('climate.now', { temp: formatTemp(state.currentTemp) })}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => nudge(device.tempStep)}
            className="flex size-11 items-center justify-center rounded-full border border-line text-fg-muted transition-colors hover:bg-elevated hover:text-fg active:scale-95"
            aria-label={t('climate.increaseSetpoint')}
          >
            <Plus className="size-4" />
          </button>
        </div>

        {/* Controlli modalità */}
        <div className="flex w-full min-w-0 flex-1 flex-col gap-3">
          <div className="grid grid-cols-4 gap-1.5">
            {MODE_BUTTONS.map(({ mode, icon: Icon }) => {
              const selected = state.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onAction({ type: 'climateMode', mode })}
                  className={cn(
                    'flex h-14 flex-col items-center justify-center gap-1 rounded-xl border text-[10px] font-medium transition-colors',
                    selected
                      ? 'border-accent/40 bg-accent-soft text-accent'
                      : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                  )}
                  aria-pressed={selected}
                >
                  <Icon className="size-4" />
                  {t(`climate.modes.${mode}`)}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
              <Wind className="size-3.5" /> {t('climate.fan')}
            </span>
            <div className="flex gap-1">
              {FAN_SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  disabled={off}
                  onClick={() => onAction({ type: 'fanSpeed', fanSpeed: speed })}
                  className={cn(
                    'h-8 min-w-8 rounded-lg border px-2 text-[11px] font-medium transition-colors',
                    state.fanSpeed === speed
                      ? 'border-accent/40 bg-accent-soft text-accent'
                      : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                    'disabled:opacity-30',
                  )}
                  aria-pressed={state.fanSpeed === speed}
                >
                  {t(`climate.fanSpeeds.${speed}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-line bg-panel-2 px-3 py-2">
            <span className="text-[11px] text-fg-subtle">{t('climate.swing')}</span>
            <button
              type="button"
              onClick={() => onAction({ type: 'swing', swing: !state.swing })}
              disabled={off}
              aria-pressed={state.swing}
              className={cn(
                'relative h-6 w-11 rounded-full transition-colors disabled:opacity-30',
                state.swing ? 'bg-accent' : 'bg-elevated',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 size-5 rounded-full bg-fg transition-transform',
                  state.swing ? 'translate-x-[22px] bg-accent-fg' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Il portale Radix esce dal sottoalbero `inert` della card: il modale
          resta usabile anche quando il widget è bloccato. */}
      <ClimateScheduleModal
        deviceId={device.id}
        deviceName={device.name}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        minTemp={device.minTemp}
        maxTemp={device.maxTemp}
        tempStep={device.tempStep}
      />

      <ClimateOverridePrompt
        deviceName={device.name}
        targetTemp={overrideDraft ?? draft}
        open={overrideDraft !== null}
        onOpenChange={(open) => {
          if (!open) setOverrideDraft(null);
        }}
        onChoose={chooseOverride}
        nextChangeAt={schedule?.nextChangeAt ?? null}
        pending={setOverride.isPending}
      />
    </div>
  );
}
