import {
  CalendarDays,
  Copy,
  Loader2,
  Minus,
  Palmtree,
  Plus,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  useClimateSchedule,
  useClimateVacation,
  useSaveClimateSchedules,
} from '@/hooks/useClimateSchedule';
import {
  DAY_ORDER,
  MIN_BAND_MINUTES,
  TIME_STEP_MINUTES,
  bandLimits,
  bandsOfDay,
  copyDay,
  daySegments,
  draftsFromSchedules,
  findFreeSlot,
  isToday,
  patchBand,
  timeFromMinutes,
  toInputs,
  weekdayLabel,
  weeklyCoverage,
} from '@/lib/climateSchedule';
import { cn, formatTemp } from '@/lib/utils';
import type { ClimatePreset, ClimateScheduleDraft, DayOfWeek } from '@/types/climate';

interface ClimateScheduleModalProps {
  deviceId: string;
  deviceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stessi limiti della manopola: il programma non esce dal range del device. */
  minTemp?: number;
  maxTemp?: number;
  tempStep?: number;
}

/** Colori delle fasce: comfort caldo, eco verde, off blu notte (antigelo). */
const BAND_COLOR: Record<ClimatePreset, string> = {
  comfort: 'bg-[#F97316]/75',
  eco: 'bg-[#10B981]/75',
  auto: 'bg-accent/60',
  off: 'bg-[#64748B]/75',
};

const DOT_COLOR: Record<ClimatePreset, string> = {
  comfort: 'bg-[#F97316]',
  eco: 'bg-[#10B981]',
  auto: 'bg-accent',
  off: 'bg-[#64748B]',
};

const PRESETS: readonly ClimatePreset[] = ['comfort', 'eco', 'auto', 'off'];

function percentOf(minutes: number): string {
  return `${(minutes / (24 * 60)) * 100}%`;
}

function Stepper({
  label,
  value,
  onDecrease,
  onIncrease,
  decreaseLabel,
  increaseLabel,
  disabledDecrease,
  disabledIncrease,
  className,
}: {
  label: string;
  value: string;
  onDecrease: () => void;
  onIncrease: () => void;
  decreaseLabel: string;
  increaseLabel: string;
  disabledDecrease?: boolean;
  disabledIncrease?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <span className="text-[11px] font-medium text-fg-muted">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onDecrease}
          disabled={disabledDecrease}
          aria-label={decreaseLabel}
          className="flex size-12 items-center justify-center rounded-xl border border-line bg-panel-2 text-fg-muted transition-colors hover:bg-elevated hover:text-fg active:scale-95 disabled:opacity-30"
        >
          <Minus className="size-4" />
        </button>
        <span className="tabular w-20 text-center text-base font-medium text-fg">{value}</span>
        <button
          type="button"
          onClick={onIncrease}
          disabled={disabledIncrease}
          aria-label={increaseLabel}
          className="flex size-12 items-center justify-center rounded-xl border border-line bg-panel-2 text-fg-muted transition-colors hover:bg-elevated hover:text-fg active:scale-95 disabled:opacity-30"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function ClimateScheduleModal({
  deviceId,
  deviceName,
  open,
  onOpenChange,
  minTemp = 5,
  maxTemp = 30,
  tempStep = 0.5,
}: ClimateScheduleModalProps) {
  const { t } = useTranslation('devices');
  const schedule = useClimateSchedule(deviceId, { enabled: open });
  const save = useSaveClimateSchedules(deviceId);
  const vacation = useClimateVacation(deviceId);

  const [drafts, setDrafts] = useState<ClimateScheduleDraft[]>([]);
  const [day, setDay] = useState<DayOfWeek>(() => new Date().getDay() as DayOfWeek);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copyTargets, setCopyTargets] = useState<DayOfWeek[]>([]);
  const [vacationUntil, setVacationUntil] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const initializedForOpen = useRef(false);

  // La bozza si ricostruisce solo all'apertura: un refetch in background non
  // deve cancellare le modifiche in corso.
  useEffect(() => {
    if (!open) {
      initializedForOpen.current = false;
      return;
    }
    if (initializedForOpen.current) return;
    setDay(new Date().getDay() as DayOfWeek);
    setSelectedKey(null);
    setCopyTargets([]);
    setNotice(null);
    if (!schedule.data) return;
    setDrafts(draftsFromSchedules(schedule.data.schedules));
    initializedForOpen.current = true;
  }, [open, schedule.data]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const dayBands = bandsOfDay(drafts, day);
  const segments = daySegments(drafts, day);
  const selected = drafts.find((draft) => draft.key === selectedKey) ?? null;
  const limits = selected ? bandLimits(drafts, selected.key) : { minStart: 0, maxEnd: 24 * 60 };
  const freeSlot = findFreeSlot(drafts, day);
  const coverageHours = Math.round((weeklyCoverage(drafts) / 60) * 10) / 10;
  const activeVacation = schedule.data?.runtime?.vacation ?? null;
  const onVacation = activeVacation !== null;

  const updateBand = (key: string, patch: Parameters<typeof patchBand>[2]) => {
    setDrafts((current) =>
      patchBand(current, key, patch, { minTemp, maxTemp, tempStep }),
    );
  };

  const addBand = () => {
    if (!freeSlot) return;
    const key = `new-${day}-${freeSlot.startMinute}-${Date.now()}`;
    setDrafts((current) => [
      ...current,
      {
        key,
        dayOfWeek: day,
        startMinute: freeSlot.startMinute,
        endMinute: freeSlot.endMinute,
        targetTemp: 20,
        preset: 'comfort',
        isActive: true,
      },
    ]);
    setSelectedKey(key);
  };

  const removeBand = (key: string) => {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
    setSelectedKey((current) => (current === key ? null : current));
  };

  const copyToDays = () => {
    if (copyTargets.length === 0) return;
    setDrafts((current) => copyDay(current, day, copyTargets));
    setCopyTargets([]);
    setNotice(t('climate.schedule.copied', { count: copyTargets.length }));
  };

  const onSave = () => {
    save.mutate(toInputs(drafts), {
      onSuccess: () => setNotice(t('climate.schedule.saved')),
    });
  };

  const activateVacation = () => {
    if (!vacationUntil) return;
    vacation.mutate(
      { active: true, until: new Date(vacationUntil).toISOString() },
      { onSuccess: () => setVacationUntil('') },
    );
  };

  const errorMessage =
    (save.error as { message?: string } | null)?.message ??
    (vacation.error as { message?: string } | null)?.message ??
    null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ignore-swipe flex max-h-[92vh] w-[min(96vw,62rem)] flex-col gap-0 overflow-hidden p-0">
        <header className="shrink-0 border-b border-line px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="size-5 text-accent" aria-hidden />
            {t('climate.schedule.title')}
          </DialogTitle>
          <DialogDescription>
            {deviceName} · {t('climate.schedule.description')}
          </DialogDescription>

          {/* Tab dei giorni: bersagli ampi, ordine lunedì → domenica. */}
          <div className="mt-4 grid grid-cols-7 gap-1.5">
            {DAY_ORDER.map((value) => {
              const selectedDay = value === day;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setDay(value);
                    setSelectedKey(null);
                    setCopyTargets([]);
                  }}
                  aria-pressed={selectedDay}
                  aria-label={weekdayLabel(value, 'long')}
                  className={cn(
                    'relative flex h-12 items-center justify-center rounded-xl border text-[12px] font-medium capitalize transition-colors',
                    selectedDay
                      ? 'border-accent/40 bg-accent-soft text-accent'
                      : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                  )}
                >
                  {weekdayLabel(value)}
                  {isToday(value) ? (
                    <span className="absolute bottom-1.5 size-1 rounded-full bg-current" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {schedule.isPending ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('climate.schedule.loading')}
            </div>
          ) : schedule.isError ? (
            <div className="flex h-40 flex-col items-center justify-center gap-3 text-sm text-fg-muted">
              <p>{t('climate.schedule.loadError')}</p>
              <button
                type="button"
                onClick={() => void schedule.refetch()}
                className="h-12 rounded-xl border border-line bg-panel-2 px-4 text-fg transition-colors hover:bg-elevated"
              >
                {t('climate.schedule.retry')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Timeline 00:00–24:00 del giorno scelto. */}
              <div>
                <div className="relative h-12 overflow-hidden rounded-xl border border-line bg-panel-2">
                  {segments.map((segment) => (
                    <div
                      key={segment.key}
                      className={cn(
                        'absolute inset-y-0',
                        segment.kind === 'band'
                          ? BAND_COLOR[segment.preset ?? 'off']
                          : 'bg-elevated/60',
                      )}
                      style={{
                        left: percentOf(segment.startMinute),
                        width: percentOf(segment.endMinute - segment.startMinute),
                      }}
                    />
                  ))}
                  {dayBands.map((band) => (
                    <button
                      key={band.key}
                      type="button"
                      onClick={() => setSelectedKey(band.key)}
                      aria-label={t('climate.schedule.selectBand', {
                        start: timeFromMinutes(band.startMinute),
                        end: timeFromMinutes(band.endMinute),
                      })}
                      className={cn(
                        'absolute inset-y-0 border-x border-black/20 transition-shadow',
                        selectedKey === band.key && 'ring-2 ring-inset ring-fg',
                      )}
                      style={{
                        left: percentOf(band.startMinute),
                        width: percentOf(band.endMinute - band.startMinute),
                      }}
                    />
                  ))}
                </div>
                <div className="tabular mt-1 flex justify-between text-[10px] text-fg-subtle">
                  <span>00</span>
                  <span>06</span>
                  <span>12</span>
                  <span>18</span>
                  <span>24</span>
                </div>
                <p className="mt-1 text-[10px] text-fg-subtle">{t('climate.schedule.gapHint')}</p>
              </div>

              {/* Fasce del giorno + aggiunta. */}
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
                  {weekdayLabel(day, 'long')}
                </h3>
                <button
                  type="button"
                  onClick={addBand}
                  disabled={!freeSlot}
                  className="flex h-12 items-center gap-1.5 rounded-xl border border-accent/40 bg-accent-soft px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/15 disabled:opacity-40"
                >
                  <Plus className="size-4" aria-hidden />
                  {t('climate.schedule.add')}
                </button>
              </div>

              {dayBands.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12px] text-fg-muted">
                  {t('climate.schedule.emptyDay')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {dayBands.map((band) => {
                    const isSelected = band.key === selectedKey;
                    return (
                      <li key={band.key}>
                        <button
                          type="button"
                          onClick={() => setSelectedKey(isSelected ? null : band.key)}
                          aria-pressed={isSelected}
                          className={cn(
                            'flex h-14 w-full items-center gap-3 rounded-xl border px-3 text-left transition-colors',
                            isSelected
                              ? 'border-accent/40 bg-accent-soft'
                              : 'border-line bg-panel-2 hover:bg-elevated',
                          )}
                        >
                          <span
                            className={cn('size-2.5 shrink-0 rounded-full', DOT_COLOR[band.preset])}
                            aria-hidden
                          />
                          <span className="tabular text-sm font-medium text-fg">
                            {timeFromMinutes(band.startMinute)}–{timeFromMinutes(band.endMinute)}
                          </span>
                          <span className="tabular text-sm text-fg-muted">
                            {formatTemp(band.targetTemp)}
                          </span>
                          <span className="ml-auto text-[11px] text-fg-subtle">
                            {t(`climate.schedule.presets.${band.preset}`)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Editor della fascia selezionata. */}
              {selected ? (
                <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel-2 p-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Stepper
                      label={t('climate.schedule.start')}
                      value={timeFromMinutes(selected.startMinute)}
                      onDecrease={() =>
                        updateBand(selected.key, {
                          startMinute: selected.startMinute - TIME_STEP_MINUTES,
                        })
                      }
                      onIncrease={() =>
                        updateBand(selected.key, {
                          startMinute: selected.startMinute + TIME_STEP_MINUTES,
                        })
                      }
                      decreaseLabel={t('climate.schedule.earlier')}
                      increaseLabel={t('climate.schedule.later')}
                      disabledDecrease={selected.startMinute <= limits.minStart}
                      disabledIncrease={selected.endMinute - selected.startMinute <= MIN_BAND_MINUTES}
                    />
                    <Stepper
                      label={t('climate.schedule.end')}
                      value={timeFromMinutes(selected.endMinute)}
                      onDecrease={() =>
                        updateBand(selected.key, {
                          endMinute: selected.endMinute - TIME_STEP_MINUTES,
                        })
                      }
                      onIncrease={() =>
                        updateBand(selected.key, {
                          endMinute: selected.endMinute + TIME_STEP_MINUTES,
                        })
                      }
                      decreaseLabel={t('climate.schedule.earlier')}
                      increaseLabel={t('climate.schedule.later')}
                      disabledDecrease={selected.endMinute - selected.startMinute <= MIN_BAND_MINUTES}
                      disabledIncrease={selected.endMinute >= limits.maxEnd}
                    />
                    <Stepper
                      className="sm:col-span-2"
                      label={t('climate.schedule.target')}
                      value={formatTemp(selected.targetTemp)}
                      onDecrease={() =>
                        updateBand(selected.key, { targetTemp: selected.targetTemp - tempStep })
                      }
                      onIncrease={() =>
                        updateBand(selected.key, { targetTemp: selected.targetTemp + tempStep })
                      }
                      decreaseLabel={t('climate.schedule.colder')}
                      increaseLabel={t('climate.schedule.warmer')}
                      disabledDecrease={selected.targetTemp <= minTemp}
                      disabledIncrease={selected.targetTemp >= maxTemp}
                    />
                  </div>

                  <div className="grid grid-cols-4 gap-1.5">
                    {PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => updateBand(selected.key, { preset })}
                        aria-pressed={selected.preset === preset}
                        className={cn(
                          'flex h-12 items-center justify-center gap-1.5 rounded-xl border text-[11px] font-medium transition-colors',
                          selected.preset === preset
                            ? 'border-accent/40 bg-accent-soft text-accent'
                            : 'border-line bg-panel text-fg-muted hover:text-fg',
                        )}
                      >
                        <span
                          className={cn('size-2 rounded-full', DOT_COLOR[preset])}
                          aria-hidden
                        />
                        {t(`climate.schedule.presets.${preset}`)}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => removeBand(selected.key)}
                    className="flex h-12 items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/10 text-[12px] font-medium text-danger transition-colors hover:bg-danger/15"
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {t('climate.schedule.remove')}
                  </button>
                </section>
              ) : null}

              {/* Copia del giorno su altri giorni. */}
              <section className="flex flex-col gap-2 rounded-2xl border border-line bg-panel-2 p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted">
                  <Copy className="size-3.5" aria-hidden />
                  {t('climate.schedule.copyTitle', { day: weekdayLabel(day, 'long') })}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_ORDER.filter((value) => value !== day).map((value) => {
                    const chosen = copyTargets.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          setCopyTargets((current) =>
                            current.includes(value)
                              ? current.filter((item) => item !== value)
                              : [...current, value],
                          )
                        }
                        aria-pressed={chosen}
                        aria-label={weekdayLabel(value, 'long')}
                        className={cn(
                          'h-12 min-w-14 rounded-xl border px-3 text-[11px] font-medium capitalize transition-colors',
                          chosen
                            ? 'border-accent/40 bg-accent-soft text-accent'
                            : 'border-line bg-panel text-fg-muted hover:text-fg',
                        )}
                      >
                        {weekdayLabel(value)}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={copyToDays}
                  disabled={copyTargets.length === 0 || dayBands.length === 0}
                  className="h-12 rounded-xl border border-line bg-panel text-[12px] font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-40"
                >
                  {t('climate.schedule.copyAction', { count: copyTargets.length })}
                </button>
              </section>

              {/* Vacanza: spegne il programma fino al rientro. */}
              <section className="flex flex-col gap-2 rounded-2xl border border-line bg-panel-2 p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted">
                  <Palmtree className="size-3.5" aria-hidden />
                  {t('climate.schedule.vacation.title')}
                </p>
                <p className="text-[11px] text-fg-subtle">{t('climate.schedule.vacation.hint')}</p>
                {onVacation ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <span className="h-12 flex-1 rounded-xl border border-warning/30 bg-warning/10 px-3 text-[12px] leading-[3rem] text-warning">
                      {activeVacation?.until
                        ? t('climate.schedule.vacation.activeUntil', {
                            date: new Date(activeVacation.until).toLocaleString(undefined, {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            }),
                          })
                        : t('climate.schedule.vacation.activeNoEnd')}
                    </span>
                    <button
                      type="button"
                      onClick={() => vacation.mutate({ active: false, until: null })}
                      disabled={vacation.isPending}
                      className="h-12 rounded-xl border border-line bg-panel px-4 text-[12px] font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-40"
                    >
                      {t('climate.schedule.vacation.stop')}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="flex h-12 flex-1 items-center gap-2 rounded-xl border border-line bg-panel px-3 text-[11px] text-fg-muted">
                      <span className="shrink-0">{t('climate.schedule.vacation.return')}</span>
                      <input
                        type="datetime-local"
                        value={vacationUntil}
                        onChange={(event) => setVacationUntil(event.target.value)}
                        className="tabular h-10 min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={activateVacation}
                      disabled={!vacationUntil || vacation.isPending}
                      className="h-12 rounded-xl border border-warning/30 bg-warning/10 px-4 text-[12px] font-medium text-warning transition-colors hover:bg-warning/15 disabled:opacity-40"
                    >
                      {t('climate.schedule.vacation.activate')}
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-line bg-panel/80 px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className="tabular text-[11px] text-fg-subtle">
              {t('climate.schedule.coverage', { hours: coverageHours })}
            </p>
            <div className="flex flex-1 flex-col items-stretch gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-12 rounded-xl border border-line px-4 text-[12px] font-medium text-fg-muted transition-colors hover:bg-elevated hover:text-fg sm:min-w-32"
              >
                {t('climate.schedule.cancel')}
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={save.isPending || schedule.isPending}
                className="flex h-12 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[12px] font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40 sm:min-w-40"
              >
                {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {save.isPending ? t('climate.schedule.saving') : t('climate.schedule.save')}
              </button>
            </div>
          </div>
          {errorMessage ? (
            <p role="alert" className="mt-2 text-[11px] text-danger">
              {errorMessage}
            </p>
          ) : notice ? (
            <p role="status" className="mt-2 text-[11px] text-accent">
              {notice}
            </p>
          ) : null}
        </footer>

      </DialogContent>
    </Dialog>
  );
}
