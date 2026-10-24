import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Field, FormError, ToggleField, selectClass } from '@/components/admin/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, type ScenarioPayload } from '@/lib/adminApi';
import { roomIdFromLabel } from '@/lib/rooms';
import type {
  ClimateMode,
  ControlAction,
  DeviceMetadata,
  FanSpeed,
  Scenario,
  ScenarioStep,
} from '@/types/device';

const ACTIONS: readonly ControlAction['type'][] = [
  'power',
  'brightness',
  'colorTemp',
  'targetTemp',
  'climateMode',
  'fanSpeed',
  'swing',
  'volume',
  'source',
];

const CLIMATE_MODES: ClimateMode[] = ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry'];
const FAN_SPEEDS: FanSpeed[] = ['auto', 'low', 'medium', 'high'];

/** Valore iniziale sensato quando l'utente cambia tipo di azione. */
function defaultAction(type: ControlAction['type']): ControlAction {
  switch (type) {
    case 'power':
      return { type, on: true };
    case 'brightness':
      return { type, brightness: 50 };
    case 'colorTemp':
      return { type, kelvin: 2_700 };
    case 'targetTemp':
      return { type, targetTemp: 20 };
    case 'climateMode':
      return { type, mode: 'auto' };
    case 'fanSpeed':
      return { type, fanSpeed: 'auto' };
    case 'swing':
      return { type, swing: true };
    case 'volume':
      return { type, volume: 30 };
    case 'source':
      return { type, source: 'HDMI 1' };
  }
}

function numberValue(event: { target: { value: string } }): number | null {
  const parsed = Number(event.target.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ActionValue({
  index,
  action,
  onChange,
}: {
  index: number;
  action: ControlAction;
  onChange: (action: ControlAction) => void;
}) {
  const { t } = useTranslation();
  const { t: tDevices } = useTranslation('devices');
  const label = t('forms.scenario.valueAria', { index: index + 1 });
  switch (action.type) {
    case 'power':
      return (
        <select
          className={selectClass}
          aria-label={label}
          value={action.on ? 'on' : 'off'}
          onChange={(event) => onChange({ type: 'power', on: event.target.value === 'on' })}
        >
          <option value="on">{t('forms.scenario.on')}</option>
          <option value="off">{t('forms.scenario.off')}</option>
        </select>
      );
    case 'brightness':
      return (
        <Input
          type="number"
          min={0}
          max={100}
          aria-label={label}
          value={action.brightness}
          onChange={(event) => {
            const value = numberValue(event);
            if (value !== null) onChange({ type: 'brightness', brightness: value });
          }}
        />
      );
    case 'colorTemp':
      return (
        <Input
          type="number"
          min={1000}
          max={10000}
          step={50}
          aria-label={label}
          value={action.kelvin}
          onChange={(event) => {
            const value = numberValue(event);
            if (value !== null) onChange({ type: 'colorTemp', kelvin: value });
          }}
        />
      );
    case 'targetTemp':
      return (
        <Input
          type="number"
          min={5}
          max={35}
          step={0.5}
          aria-label={label}
          value={action.targetTemp}
          onChange={(event) => {
            const value = numberValue(event);
            if (value !== null) onChange({ type: 'targetTemp', targetTemp: value });
          }}
        />
      );
    case 'climateMode':
      return (
        <select
          className={selectClass}
          aria-label={label}
          value={action.mode}
          onChange={(event) =>
            onChange({ type: 'climateMode', mode: event.target.value as ClimateMode })
          }
        >
          {CLIMATE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {tDevices(`climate.modes.${mode}`)}
            </option>
          ))}
        </select>
      );
    case 'fanSpeed':
      return (
        <select
          className={selectClass}
          aria-label={label}
          value={action.fanSpeed}
          onChange={(event) =>
            onChange({ type: 'fanSpeed', fanSpeed: event.target.value as FanSpeed })
          }
        >
          {FAN_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {tDevices(`climate.fanSpeeds.${speed}`)}
            </option>
          ))}
        </select>
      );
    case 'swing':
      return (
        <select
          className={selectClass}
          aria-label={label}
          value={action.swing ? 'on' : 'off'}
          onChange={(event) => onChange({ type: 'swing', swing: event.target.value === 'on' })}
        >
          <option value="on">{t('forms.scenario.enable')}</option>
          <option value="off">{t('forms.scenario.disable')}</option>
        </select>
      );
    case 'volume':
      return (
        <Input
          type="number"
          min={0}
          max={100}
          aria-label={label}
          value={action.volume}
          onChange={(event) => {
            const value = numberValue(event);
            if (value !== null) onChange({ type: 'volume', volume: value });
          }}
        />
      );
    case 'source':
      return (
        <Input
          aria-label={label}
          value={action.source}
          maxLength={80}
          onChange={(event) => onChange({ type: 'source', source: event.target.value })}
        />
      );
  }
}

export function ScenarioForm({
  scenario,
  devices,
  onSaved,
  onCancel,
}: {
  scenario?: Scenario;
  devices: readonly DeviceMetadata[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(scenario?.label ?? '');
  const [id, setId] = useState(scenario?.id ?? '');
  const [idTouched, setIdTouched] = useState(Boolean(scenario));
  const [description, setDescription] = useState(scenario?.description ?? '');
  const [icon, setIcon] = useState(scenario?.icon ?? 'sparkles');
  const [protectedScenario, setProtectedScenario] = useState(scenario?.protected ?? false);
  const [displayOrder, setDisplayOrder] = useState(String(scenario?.displayOrder ?? 0));
  const [steps, setSteps] = useState<ScenarioStep[]>(scenario ? [...scenario.steps] : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changeLabel = (value: string) => {
    setLabel(value);
    if (!idTouched) setId(roomIdFromLabel(value));
  };

  const patchStep = (index: number, patch: Partial<ScenarioStep>) => {
    setSteps((current) =>
      current.map((step, position) => (position === index ? { ...step, ...patch } : step)),
    );
  };

  const addStep = () => {
    setSteps((current) => [
      ...current,
      {
        deviceId: current.at(-1)?.deviceId ?? devices[0]?.id ?? '',
        action: { type: 'power', on: true },
      },
    ]);
  };

  const removeStep = (index: number) => {
    setSteps((current) => current.filter((_, position) => position !== index));
  };

  const moveStep = (index: number, delta: number) => {
    setSteps((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (!moved) return current;
      next.splice(target, 0, moved);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    if (steps.some((step) => step.deviceId.length === 0)) {
      setError(t('forms.scenario.noDevice'));
      setBusy(false);
      return;
    }

    try {
      const payload: ScenarioPayload = {
        label: label.trim(),
        description: description.trim(),
        icon: icon.trim() || 'sparkles',
        protected: protectedScenario,
        actions: steps.map((step) => ({
          deviceId: step.deviceId,
          action: step.action,
          ...(step.delayMs ? { delayMs: step.delayMs } : {}),
        })),
        displayOrder: Number(displayOrder) || 0,
      };
      if (scenario) {
        await adminApi.updateScenario(scenario.id, payload);
      } else {
        await adminApi.createScenario({ ...payload, id: id.trim() || undefined });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('forms.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('forms.name')}>
          <Input
            value={label}
            onChange={(event) => changeLabel(event.target.value)}
            required
            maxLength={80}
            placeholder={t('forms.scenario.namePlaceholder')}
          />
        </Field>
        <Field
          label={t('forms.id')}
          hint={scenario ? t('forms.idLocked') : t('forms.idScenarioHint')}
        >
          <Input
            value={id}
            onChange={(event) => {
              setIdTouched(true);
              setId(event.target.value);
            }}
            disabled={Boolean(scenario)}
            required
            maxLength={64}
            pattern="[a-z0-9][a-z0-9:_-]*"
            placeholder="goodnight"
          />
        </Field>
        <Field label={t('forms.scenario.description')}>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={240}
            placeholder={t('forms.scenario.descriptionPlaceholder')}
          />
        </Field>
        <Field label={t('forms.icon')} hint={t('forms.scenario.iconHint')}>
          <Input
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            maxLength={40}
            placeholder="moon"
          />
        </Field>
        <Field label={t('forms.order')} hint={t('forms.orderHint')}>
          <Input
            type="number"
            min={0}
            max={9999}
            value={displayOrder}
            onChange={(event) => setDisplayOrder(event.target.value)}
          />
        </Field>
      </div>

      <ToggleField
        label={t('forms.scenario.pin')}
        hint={t('forms.scenario.pinHint')}
        checked={protectedScenario}
        onChange={setProtectedScenario}
      />

      <section className="flex flex-col gap-2" aria-label={t('forms.scenario.stepsAria')}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-fg">{t('forms.scenario.steps')}</p>
            <p className="mt-0.5 text-[10px] text-fg-subtle">{t('forms.scenario.stepsHint')}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addStep}
            disabled={devices.length === 0}
          >
            <Plus className="size-4" /> {t('forms.scenario.addStep')}
          </Button>
        </div>

        {devices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-center text-[11px] text-fg-subtle">
            {t('forms.scenario.noDevices')}
          </p>
        ) : steps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-center text-[11px] text-fg-subtle">
            {t('forms.scenario.noSteps')}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((step, index) => {
              const knownDevice = devices.some((device) => device.id === step.deviceId);
              return (
                <li
                  key={index}
                  className="rounded-2xl border border-line bg-panel-2/60 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-fg-muted">
                      {t('forms.scenario.step', { index: index + 1 })}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('forms.scenario.moveUp', { index: index + 1 })}
                        title={t('forms.scenario.moveUpTitle')}
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('forms.scenario.moveDown', { index: index + 1 })}
                        title={t('forms.scenario.moveDownTitle')}
                        onClick={() => moveStep(index, 1)}
                        disabled={index === steps.length - 1}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-danger hover:bg-danger/10 hover:text-danger"
                        aria-label={t('forms.scenario.remove', { index: index + 1 })}
                        title={t('forms.scenario.removeTitle')}
                        onClick={() => removeStep(index)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field label={t('forms.scenario.device')}>
                      <select
                        className={selectClass}
                        aria-label={t('forms.scenario.deviceAria', { index: index + 1 })}
                        value={step.deviceId}
                        onChange={(event) => patchStep(index, { deviceId: event.target.value })}
                      >
                        {!knownDevice && step.deviceId ? (
                          <option value={step.deviceId}>
                            {step.deviceId} ({t('forms.scenario.deviceNotFound')})
                          </option>
                        ) : null}
                        {devices.map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.name} · {device.room}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('forms.scenario.action')}>
                      <select
                        className={selectClass}
                        aria-label={t('forms.scenario.actionAria', { index: index + 1 })}
                        value={step.action.type}
                        onChange={(event) =>
                          patchStep(index, {
                            action: defaultAction(event.target.value as ControlAction['type']),
                          })
                        }
                      >
                        {ACTIONS.map((action) => (
                          <option key={action} value={action}>
                            {t(`forms.scenario.actions.${action}`)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('forms.scenario.value')}>
                      <ActionValue
                        index={index}
                        action={step.action}
                        onChange={(action) => patchStep(index, { action })}
                      />
                    </Field>
                    <Field
                      label={t('forms.scenario.delay')}
                      hint={t('forms.scenario.delayHint')}
                    >
                      <Input
                        type="number"
                        min={0}
                        max={600000}
                        step={50}
                        aria-label={t('forms.scenario.delayAria', { index: index + 1 })}
                        value={step.delayMs ?? 0}
                        onChange={(event) => {
                          const value = numberValue(event);
                          if (value !== null) patchStep(index, { delayMs: value });
                        }}
                      />
                    </Field>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <FormError message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('forms.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || label.trim().length === 0}>
          {busy ? t('forms.saving') : t(scenario ? 'forms.scenario.save' : 'forms.scenario.create')}
        </Button>
      </div>
    </form>
  );
}
