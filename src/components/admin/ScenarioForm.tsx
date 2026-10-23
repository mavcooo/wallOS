import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Field, FormError, ToggleField, selectClass } from '@/components/admin/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, type ScenarioPayload } from '@/lib/adminApi';
import { roomIdFromLabel } from '@/lib/rooms';
import type {
  ClimateMode,
  ControlAction,
  Device,
  FanSpeed,
  Scenario,
  ScenarioStep,
} from '@/types/device';

const ACTIONS: { value: ControlAction['type']; label: string }[] = [
  { value: 'power', label: 'Accendi / spegni' },
  { value: 'brightness', label: 'Luminosità' },
  { value: 'colorTemp', label: 'Temperatura colore' },
  { value: 'targetTemp', label: 'Temperatura target' },
  { value: 'climateMode', label: 'Modalità clima' },
  { value: 'fanSpeed', label: 'Velocità ventola' },
  { value: 'swing', label: 'Oscillazione' },
  { value: 'volume', label: 'Volume' },
  { value: 'source', label: 'Sorgente' },
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
  const label = `Valore passo ${index + 1}`;
  switch (action.type) {
    case 'power':
      return (
        <select
          className={selectClass}
          aria-label={label}
          value={action.on ? 'on' : 'off'}
          onChange={(event) => onChange({ type: 'power', on: event.target.value === 'on' })}
        >
          <option value="on">Acceso</option>
          <option value="off">Spento</option>
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
              {mode}
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
              {speed}
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
          <option value="on">Attiva</option>
          <option value="off">Disattiva</option>
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
  devices: readonly Device[];
  onSaved: () => void;
  onCancel: () => void;
}) {
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
      setError('Ogni passo deve indicare un dispositivo');
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
      setError(cause instanceof Error ? cause.message : 'Salvataggio non riuscito');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <Input
            value={label}
            onChange={(event) => changeLabel(event.target.value)}
            required
            maxLength={80}
            placeholder="Buonanotte"
          />
        </Field>
        <Field
          label="ID (slug)"
          hint={scenario ? 'Chiave stabile: non modificabile' : 'Usato dalla API e dai test'}
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
        <Field label="Descrizione">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={240}
            placeholder="Spegne luci e abbassa le tapparelle"
          />
        </Field>
        <Field label="Icona" hint="clapperboard · moon · door-open · spa · sparkles">
          <Input
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            maxLength={40}
            placeholder="moon"
          />
        </Field>
        <Field label="Ordine" hint="Numeri più bassi compaiono prima">
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
        label="Richiede PIN"
        hint="Il kiosk chiede il PIN prima di eseguire lo scenario"
        checked={protectedScenario}
        onChange={setProtectedScenario}
      />

      <section className="flex flex-col gap-2" aria-label="Passi dello scenario">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-fg">Passi</p>
            <p className="mt-0.5 text-[10px] text-fg-subtle">
              Eseguiti in ordine: ogni passo invia un comando a un dispositivo.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addStep}
            disabled={devices.length === 0}
          >
            <Plus className="size-4" /> Aggiungi passo
          </Button>
        </div>

        {devices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-center text-[11px] text-fg-subtle">
            Nessun dispositivo disponibile: crea prima un dispositivo, poi aggiungi i passi.
          </p>
        ) : steps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-center text-[11px] text-fg-subtle">
            Nessun passo: lo scenario non invierà comandi.
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
                    <p className="text-[11px] font-semibold text-fg-muted">Passo {index + 1}</p>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Sposta su passo ${index + 1}`}
                        title="Sposta su"
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Sposta giù passo ${index + 1}`}
                        title="Sposta giù"
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
                        aria-label={`Rimuovi passo ${index + 1}`}
                        title="Rimuovi passo"
                        onClick={() => removeStep(index)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field label="Dispositivo">
                      <select
                        className={selectClass}
                        aria-label={`Dispositivo passo ${index + 1}`}
                        value={step.deviceId}
                        onChange={(event) => patchStep(index, { deviceId: event.target.value })}
                      >
                        {!knownDevice && step.deviceId ? (
                          <option value={step.deviceId}>{step.deviceId} (non trovato)</option>
                        ) : null}
                        {devices.map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.name} · {device.room}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Azione">
                      <select
                        className={selectClass}
                        aria-label={`Azione passo ${index + 1}`}
                        value={step.action.type}
                        onChange={(event) =>
                          patchStep(index, {
                            action: defaultAction(event.target.value as ControlAction['type']),
                          })
                        }
                      >
                        {ACTIONS.map((action) => (
                          <option key={action.value} value={action.value}>
                            {action.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Valore">
                      <ActionValue
                        index={index}
                        action={step.action}
                        onChange={(action) => patchStep(index, { action })}
                      />
                    </Field>
                    <Field label="Ritardo (ms)" hint="Attesa prima di eseguire il passo">
                      <Input
                        type="number"
                        min={0}
                        max={600000}
                        step={50}
                        aria-label={`Ritardo passo ${index + 1}`}
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
          Annulla
        </Button>
        <Button type="submit" variant="primary" disabled={busy || label.trim().length === 0}>
          {busy ? 'Salvataggio…' : scenario ? 'Salva scenario' : 'Crea scenario'}
        </Button>
      </div>
    </form>
  );
}
