import { Plus, Trash2 } from 'lucide-react';
import { Fragment, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Field, FormError, ToggleField, selectClass } from '@/components/admin/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSaveAutomation } from '@/hooks/useAutomations';
import { useScenarios } from '@/hooks/useTopologyQuery';
import type {
  Automation,
  AutomationAction,
  AutomationCondition,
  AutomationDraft,
  AutomationTriggerConfig,
  AutomationTriggerType,
  SunEventName,
} from '@/types/automations';
import type { DeviceMetadata } from '@/types/device';

interface AutomationFormProps {
  automation?: Automation;
  /** Anagrafica device: alimenta i menu di condizioni e azioni. */
  devices: readonly DeviceMetadata[];
  onCancel: () => void;
  onSaved: () => void;
}

type ConditionKind = AutomationCondition['type'];
type ActionKind = AutomationAction['type'];

/** Righe modificabili: gli stessi campi delle entità, ma tutte opzionali. */
interface ConditionRow {
  key: number;
  type: ConditionKind;
  start: string;
  end: string;
  deviceId: string;
  expectedState: string;
  requireHome: boolean;
}

/**
 * Gruppo di condizioni: dentro il gruppo è un AND, fra i gruppi è un OR. Il
 * primo gruppo finisce in `conditions`, gli altri in `condition_groups`: la
 * distinzione è di persistenza, per il form sono tutti uguali.
 */
interface ConditionGroupRow {
  key: number;
  conditions: ConditionRow[];
}

interface ActionRow {
  key: number;
  kind: ActionKind;
  topic: string;
  payload: string;
  delayMs: string;
  scenarioId: string;
}

let rowSequence = 0;
const nextKey = (): number => {
  rowSequence += 1;
  return rowSequence;
};

function emptyCondition(): ConditionRow {
  return {
    key: nextKey(),
    type: 'time_range',
    start: '23:00',
    end: '06:00',
    deviceId: '',
    expectedState: 'OFF',
    requireHome: true,
  };
}

function emptyGroup(): ConditionGroupRow {
  return { key: nextKey(), conditions: [] };
}

function emptyAction(): ActionRow {
  return { key: nextKey(), kind: 'mqtt', topic: '', payload: '', delayMs: '0', scenarioId: '' };
}

/** Riga del server → riga del form (per la modifica di una regola esistente). */
function toConditionRow(condition: AutomationCondition): ConditionRow {
  const row = emptyCondition();
  row.type = condition.type;
  if (condition.type === 'time_range') {
    row.start = condition.start;
    row.end = condition.end;
  } else if (condition.type === 'device_state') {
    row.deviceId = condition.deviceId;
    row.expectedState = condition.expectedState;
  } else {
    row.requireHome = condition.requireHome;
  }
  return row;
}

function toActionRow(action: AutomationAction): ActionRow {
  const row = emptyAction();
  row.kind = action.type;
  row.delayMs = String(action.delayMs ?? 0);
  if (action.type === 'scenario') {
    row.scenarioId = action.scenarioId;
  } else {
    row.topic = action.topic;
    row.payload = action.payload;
  }
  return row;
}

/** Gruppi del server → gruppi del form; i gruppi vuoti non si mostrano. */
function toGroups(automation?: Automation): ConditionGroupRow[] {
  const groups = [
    ...(automation ? [automation.conditions] : []),
    ...(automation?.conditionGroups ?? []),
  ].filter((group) => group.length > 0);
  return groups.map((group) => ({
    key: nextKey(),
    conditions: group.map(toConditionRow),
  }));
}

function toCondition(row: ConditionRow): AutomationCondition {
  if (row.type === 'time_range') {
    return { type: 'time_range', start: row.start, end: row.end };
  }
  if (row.type === 'device_state') {
    return {
      type: 'device_state',
      deviceId: row.deviceId.trim(),
      expectedState: row.expectedState.trim(),
    };
  }
  return { type: 'user_present', requireHome: row.requireHome };
}

function toAction(row: ActionRow): AutomationAction {
  const delayMs = Number(row.delayMs) || 0;
  if (row.kind === 'scenario') {
    return { type: 'scenario', scenarioId: row.scenarioId, delayMs };
  }
  return { type: 'mqtt', topic: row.topic.trim(), payload: row.payload, delayMs };
}

/**
 * Il valore atteso viaggia come stringa nel form: `true/false` diventano
 * booleani e i numeri restano numeri, perché il payload di un sensore è
 * tipizzato e il confronto lato motore è esatto.
 */
function parseExpectedValue(raw: string): string | number | boolean | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

/**
 * Builder visuale di una regola Trigger → Conditions → Actions.
 *
 * Il form non ricalcola nulla del motore: costruisce il payload e lascia la
 * validazione al server (Zod), mostrando il messaggio d'errore che arriva da
 * lì. Su un pannello a parete un errore silenzioso è peggio di un errore
 * esplicito.
 */
export function AutomationForm({ automation, devices, onCancel, onSaved }: AutomationFormProps) {
  const { t } = useTranslation('automations');
  const save = useSaveAutomation();
  const scenarios = useScenarios();

  const initialTrigger = (automation?.triggerConfig ?? {}) as Record<string, unknown>;
  const readText = (key: string): string =>
    typeof initialTrigger[key] === 'string' ? (initialTrigger[key] as string) : '';

  const [name, setName] = useState(automation?.name ?? '');
  const [description, setDescription] = useState(automation?.description ?? '');
  const [isActive, setIsActive] = useState(automation?.isActive ?? true);
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>(
    automation?.triggerType ?? 'mqtt_state',
  );
  const [topic, setTopic] = useState(readText('topic'));
  const [payloadKey, setPayloadKey] = useState(readText('payloadKey'));
  const [expectedValue, setExpectedValue] = useState(
    initialTrigger['expectedValue'] === undefined ? '' : String(initialTrigger['expectedValue']),
  );
  const [cron, setCron] = useState(readText('cron') || '0 23 * * *');
  const [sunEvent, setSunEvent] = useState<SunEventName>(
    initialTrigger['event'] === 'sunrise' ? 'sunrise' : 'sunset',
  );
  const [offsetMinutes, setOffsetMinutes] = useState(
    typeof initialTrigger['offsetMinutes'] === 'number' ? String(initialTrigger['offsetMinutes']) : '0',
  );

  const [groups, setGroups] = useState<ConditionGroupRow[]>(() => toGroups(automation));
  const [actions, setActions] = useState<ActionRow[]>(
    () => automation?.actions.map(toActionRow) ?? [emptyAction()],
  );
  const [error, setError] = useState<string | null>(null);

  const commandableDevices = devices.filter((device) => Boolean(device.topics.command));

  const patchGroup = (groupKey: number, patch: Partial<ConditionGroupRow>): void => {
    setGroups((rows) => rows.map((row) => (row.key === groupKey ? { ...row, ...patch } : row)));
  };

  const patchCondition = (
    groupKey: number,
    conditionKey: number,
    patch: Partial<ConditionRow>,
  ): void => {
    setGroups((rows) =>
      rows.map((row) =>
        row.key === groupKey
          ? {
              ...row,
              conditions: row.conditions.map((condition) =>
                condition.key === conditionKey ? { ...condition, ...patch } : condition,
              ),
            }
          : row,
      ),
    );
  };

  const addCondition = (groupKey: number): void => {
    const group = groups.find((row) => row.key === groupKey);
    if (!group) return;
    patchGroup(groupKey, { conditions: [...group.conditions, emptyCondition()] });
  };

  const removeCondition = (groupKey: number, conditionKey: number): void => {
    const group = groups.find((row) => row.key === groupKey);
    if (!group) return;
    patchGroup(groupKey, {
      conditions: group.conditions.filter((condition) => condition.key !== conditionKey),
    });
  };

  const patchAction = (key: number, patch: Partial<ActionRow>): void => {
    setActions((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const buildTriggerConfig = (): AutomationTriggerConfig => {
    if (triggerType === 'mqtt_state') {
      const config: AutomationTriggerConfig = { topic: topic.trim() };
      if (payloadKey.trim()) (config as { payloadKey?: string }).payloadKey = payloadKey.trim();
      const expected = parseExpectedValue(expectedValue);
      if (expected !== undefined) (config as { expectedValue?: unknown }).expectedValue = expected;
      return config;
    }
    if (triggerType === 'time_cron') return { cron: cron.trim() };
    return { event: sunEvent, offsetMinutes: Number(offsetMinutes) || 0 };
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError(t('form.errors.name'));
      return;
    }
    if (triggerType === 'mqtt_state' && !topic.trim()) {
      setError(t('form.errors.topic'));
      return;
    }
    if (triggerType === 'time_cron' && !cron.trim()) {
      setError(t('form.errors.cron'));
      return;
    }
    if (actions.some((action) => action.kind === 'mqtt' && !action.topic.trim())) {
      setError(t('form.errors.actionTopic'));
      return;
    }
    if (actions.some((action) => action.kind === 'scenario' && !action.scenarioId)) {
      setError(t('form.errors.actionScenario'));
      return;
    }

    // Un gruppo lasciato vuoto viene scartato: il motore lo ignorerebbe
    // comunque, ma il server rifiuta i gruppi vuoti.
    const filledGroups = groups
      .map((group) => group.conditions.map(toCondition))
      .filter((group) => group.length > 0);

    const draft: AutomationDraft = {
      name: name.trim(),
      description: description.trim() || null,
      isActive,
      triggerType,
      triggerConfig: buildTriggerConfig(),
      conditions: filledGroups[0] ?? [],
      conditionGroups: filledGroups.slice(1),
      actions: actions.map(toAction),
    };

    try {
      await save.mutateAsync({ ...(automation ? { id: automation.id } : {}), draft });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('form.errors.save'));
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <p className="text-[11px] leading-relaxed text-fg-subtle">{t('form.description')}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('form.name')}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('form.namePlaceholder')}
            maxLength={128}
          />
        </Field>
        <Field label={t('form.notes')}>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('form.notesPlaceholder')}
            maxLength={2000}
          />
        </Field>
      </div>

      <ToggleField
        label={t('form.active')}
        hint={t('form.activeHint')}
        checked={isActive}
        onChange={setIsActive}
      />

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel-2/60 p-3">
        <p className="text-xs font-semibold text-fg">{t('form.triggerSection')}</p>

        <Field label={t('form.triggerType')}>
          <select
            className={selectClass}
            value={triggerType}
            onChange={(event) => setTriggerType(event.target.value as AutomationTriggerType)}
          >
            <option value="mqtt_state">{t('trigger.mqtt_state')}</option>
            <option value="time_cron">{t('trigger.time_cron')}</option>
            <option value="sun_event">{t('trigger.sun_event')}</option>
          </select>
        </Field>

        {triggerType === 'mqtt_state' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('form.topic')} hint={t('form.topicHint')} className="sm:col-span-1">
              <Input
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder={t('form.topicPlaceholder')}
                maxLength={256}
              />
            </Field>
            <Field label={t('form.payloadKey')} hint={t('form.payloadKeyHint')}>
              <Input
                value={payloadKey}
                onChange={(event) => setPayloadKey(event.target.value)}
                placeholder={t('form.payloadKeyPlaceholder')}
                maxLength={64}
              />
            </Field>
            <Field label={t('form.expectedValue')} hint={t('form.expectedValueHint')}>
              <Input
                value={expectedValue}
                onChange={(event) => setExpectedValue(event.target.value)}
                placeholder={t('form.expectedValuePlaceholder')}
                maxLength={256}
              />
            </Field>
          </div>
        ) : null}

        {triggerType === 'time_cron' ? (
          <Field label={t('form.cron')} hint={t('form.cronHint')}>
            <Input
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              placeholder={t('form.cronPlaceholder')}
              maxLength={128}
            />
          </Field>
        ) : null}

        {triggerType === 'sun_event' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.sunEvent')}>
              <select
                className={selectClass}
                value={sunEvent}
                onChange={(event) => setSunEvent(event.target.value as SunEventName)}
              >
                <option value="sunrise">{t('form.sunrise')}</option>
                <option value="sunset">{t('form.sunset')}</option>
              </select>
            </Field>
            <Field label={t('form.sunOffset')} hint={t('form.sunOffsetHint')}>
              <Input
                type="number"
                min={-720}
                max={720}
                value={offsetMinutes}
                onChange={(event) => setOffsetMinutes(event.target.value)}
              />
            </Field>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel-2/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-fg">{t('form.conditionsSection')}</p>
            <p className="mt-0.5 text-[10px] text-fg-subtle">{t('form.conditionsHint')}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setGroups((rows) => [...rows, emptyGroup()])}
          >
            <Plus /> {t('form.addGroup')}
          </Button>
        </div>

        {groups.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-2 text-[10px] text-fg-subtle">
            {t('badges.noConditions')}
          </p>
        ) : null}

        {groups.map((group, index) => (
          <Fragment key={group.key}>
            {index > 0 ? (
              <p className="text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
                {t('form.or')}
              </p>
            ) : null}

            <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold text-fg">
                  {t('form.group', { index: index + 1 })}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => addCondition(group.key)}
                  >
                    <Plus /> {t('form.addCondition')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('form.removeGroup')}
                    title={t('form.removeGroup')}
                    className="text-danger hover:bg-danger/10 hover:text-danger"
                    onClick={() =>
                      setGroups((rows) => rows.filter((row) => row.key !== group.key))
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>

              {group.conditions.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-3 py-2 text-[10px] text-fg-subtle">
                  {t('form.groupEmpty')}
                </p>
              ) : null}

              {group.conditions.map((row) => (
                <div
                  key={row.key}
                  className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-panel-2/60 px-3 py-2.5 sm:grid-cols-[10rem_1fr_auto]"
                >
                  <Field label={t('form.conditionType')}>
                    <select
                      className={selectClass}
                      value={row.type}
                      onChange={(event) =>
                        patchCondition(group.key, row.key, {
                          type: event.target.value as ConditionKind,
                        })
                      }
                    >
                      <option value="time_range">{t('form.timeRange')}</option>
                      <option value="device_state">{t('form.deviceState')}</option>
                      <option value="user_present">{t('form.userPresent')}</option>
                    </select>
                  </Field>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {row.type === 'time_range' ? (
                      <>
                        <Field label={t('form.start')}>
                          <Input
                            type="time"
                            value={row.start}
                            onChange={(event) =>
                              patchCondition(group.key, row.key, { start: event.target.value })
                            }
                          />
                        </Field>
                        <Field label={t('form.end')}>
                          <Input
                            type="time"
                            value={row.end}
                            onChange={(event) =>
                              patchCondition(group.key, row.key, { end: event.target.value })
                            }
                          />
                        </Field>
                      </>
                    ) : null}

                    {row.type === 'device_state' ? (
                      <>
                        <Field label={t('form.device')}>
                          <select
                            className={selectClass}
                            value={row.deviceId}
                            onChange={(event) =>
                              patchCondition(group.key, row.key, { deviceId: event.target.value })
                            }
                          >
                            <option value="">{t('form.devicePlaceholder')}</option>
                            {devices.map((device) => (
                              <option key={device.id} value={device.id}>
                                {device.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t('form.expectedState')}>
                          <Input
                            value={row.expectedState}
                            onChange={(event) =>
                              patchCondition(group.key, row.key, {
                                expectedState: event.target.value,
                              })
                            }
                            maxLength={64}
                          />
                        </Field>
                      </>
                    ) : null}

                    {row.type === 'user_present' ? (
                      <div className="sm:col-span-2">
                        <ToggleField
                          label={row.requireHome ? t('form.requireHome') : t('form.requireAway')}
                          checked={row.requireHome}
                          onChange={(value) =>
                            patchCondition(group.key, row.key, { requireHome: value })
                          }
                        />
                      </div>
                    ) : null}
                  </div>

                  <div className="flex items-start justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('action.remove')}
                      title={t('action.remove')}
                      className="text-danger hover:bg-danger/10 hover:text-danger"
                      onClick={() => removeCondition(group.key, row.key)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Fragment>
        ))}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel-2/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-fg">{t('form.actionsSection')}</p>
            <p className="mt-0.5 text-[10px] text-fg-subtle">{t('form.actionsHint')}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setActions((rows) => [...rows, emptyAction()])}
          >
            <Plus /> {t('form.addAction')}
          </Button>
        </div>

        {actions.map((row) => (
          <div
            key={row.key}
            className="flex flex-col gap-3 rounded-xl border border-line bg-panel px-3 py-2.5"
          >
            <div className="flex items-end justify-between gap-3">
              <Field label={t('form.actionKind')} className="w-full sm:w-64">
                <select
                  className={selectClass}
                  value={row.kind}
                  onChange={(event) =>
                    patchAction(row.key, { kind: event.target.value as ActionKind })
                  }
                >
                  <option value="mqtt">{t('form.actionKindMqtt')}</option>
                  <option value="scenario">{t('form.actionKindScenario')}</option>
                </select>
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('action.remove')}
                title={t('action.remove')}
                className="text-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => setActions((rows) => rows.filter((entry) => entry.key !== row.key))}
              >
                <Trash2 />
              </Button>
            </div>

            {row.kind === 'mqtt' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_6rem_auto]">
                <Field label={t('form.actionTopic')}>
                  <Input
                    value={row.topic}
                    onChange={(event) => patchAction(row.key, { topic: event.target.value })}
                    placeholder={t('form.actionTopicPlaceholder')}
                    maxLength={256}
                  />
                </Field>
                <Field label={t('form.actionPayload')}>
                  <Input
                    value={row.payload}
                    onChange={(event) => patchAction(row.key, { payload: event.target.value })}
                    placeholder={t('form.actionPayloadPlaceholder')}
                  />
                </Field>
                <Field label={t('form.actionDelay')}>
                  <Input
                    type="number"
                    min={0}
                    max={3_600_000}
                    step={100}
                    value={row.delayMs}
                    onChange={(event) => patchAction(row.key, { delayMs: event.target.value })}
                  />
                </Field>
                <div className="flex items-end">
                  <select
                    className={selectClass}
                    aria-label={t('form.presetDevice')}
                    title={t('form.presetDevice')}
                    defaultValue=""
                    disabled={commandableDevices.length === 0}
                    onChange={(event) => {
                      const device = commandableDevices.find(
                        (entry) => entry.id === event.target.value,
                      );
                      if (device?.topics.command) {
                        patchAction(row.key, { topic: device.topics.command });
                      }
                    }}
                  >
                    <option value="">
                      {commandableDevices.length === 0
                        ? t('form.presetDeviceEmpty')
                        : t('form.presetDevice')}
                    </option>
                    {commandableDevices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_6rem]">
                <Field
                  label={t('form.actionScenario')}
                  hint={scenarios.length === 0 ? t('form.actionScenarioEmpty') : undefined}
                >
                  <select
                    className={selectClass}
                    value={row.scenarioId}
                    onChange={(event) => patchAction(row.key, { scenarioId: event.target.value })}
                  >
                    <option value="">{t('form.actionScenarioPlaceholder')}</option>
                    {scenarios.map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('form.actionDelay')}>
                  <Input
                    type="number"
                    min={0}
                    max={3_600_000}
                    step={100}
                    value={row.delayMs}
                    onChange={(event) => patchAction(row.key, { delayMs: event.target.value })}
                  />
                </Field>
              </div>
            )}
          </div>
        ))}
      </section>

      <FormError message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? t('action.saving') : t('action.save')}
        </Button>
      </div>
    </form>
  );
}
