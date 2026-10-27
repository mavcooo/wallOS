import {
  Clock,
  History,
  Pencil,
  Plus,
  Radio,
  Sun,
  Sunrise,
  Sunset,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AutomationForm } from '@/components/admin/AutomationForm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import {
  useAutomationLogs,
  useAutomations,
  useDeleteAutomation,
  useTestAutomation,
  useToggleAutomation,
} from '@/hooks/useAutomations';
import { useDevices } from '@/hooks/useTopologyQuery';
import { cn, formatRelative, formatTime } from '@/lib/utils';
import { useToastStore } from '@/store/toastStore';
import type {
  Automation,
  AutomationActionOutcome,
  AutomationActionStatus,
  AutomationLogEntry,
  AutomationRun,
  AutomationTestExecution,
} from '@/types/automations';

/** Icona del tipo di trigger: si riconosce la regola a colpo d'occhio. */
function TriggerIcon({ type, className }: { type: Automation['triggerType']; className?: string }) {
  if (type === 'time_cron') return <Clock className={className} />;
  if (type === 'sun_event') return <Sun className={className} />;
  return <Radio className={className} />;
}

/** Verde inviato, ambra saltato, rosso non inviato. */
function statusVariant(status: AutomationActionStatus): 'success' | 'warning' | 'danger' {
  if (status === 'sent') return 'success';
  return status === 'skipped' ? 'warning' : 'danger';
}

/**
 * Un'azione nel log: comando MQTT singolo, scenario con tutti i suoi comandi,
 * oppure la forma piatta delle esecuzioni registrate prima degli scenari.
 */
function LoggedAction({ action }: { action: AutomationActionOutcome }) {
  const { t } = useTranslation('automations');
  const commands = action.commands ?? [];
  const legacy = commands.length === 0 && action.topic !== undefined;

  return (
    <li className="flex flex-col gap-1 rounded-xl bg-panel/70 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-fg-subtle">
        <Badge variant={statusVariant(action.status)}>{t(`logs.${action.status}`)}</Badge>
        {action.type === 'scenario' ? (
          <span className="font-medium text-fg-muted">
            {t('logs.scenario', {
              name: action.scenarioLabel ?? action.scenarioId ?? '',
            })}
          </span>
        ) : null}
        {commands.length > 0 ? (
          <span>{t('logs.commands', { count: commands.length })}</span>
        ) : null}
        {action.error ? <span className="text-danger">{action.error}</span> : null}
        <span>{t('logs.duration', { ms: action.durationMs })}</span>
      </div>

      {legacy ? (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-fg-subtle">
          <span className="truncate font-mono">{action.topic}</span>
          <span className="font-mono text-fg-muted">{action.payload}</span>
        </div>
      ) : null}

      {commands.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {commands.map((command, index) => (
            <li
              key={`${command.topic ?? command.deviceId ?? 'step'}-${index}`}
              className="flex flex-wrap items-center gap-2 text-[10px] text-fg-subtle"
            >
              <Badge variant={statusVariant(command.status)}>
                {t(`logs.${command.status}`)}
              </Badge>
              <span className="truncate font-mono">{command.topic ?? command.deviceId}</span>
              {command.payload ? (
                <span className="font-mono text-fg-muted">{command.payload}</span>
              ) : null}
              {command.error ? <span className="text-danger">{command.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Esito da mostrare nel badge: l'ultimo arrivo fra quello registrato dal server
 * e il test appena eseguito dal pannello, così il risultato del test è
 * immediato senza aspettare il refetch della lista.
 */
function latestRun(
  automation: Automation,
  tested: AutomationTestExecution | undefined,
): (AutomationRun & { automated?: boolean }) | null {
  const stored = automation.lastRun;
  if (!tested) return stored;
  const candidate: AutomationRun & { automated?: boolean } = {
    at: tested.triggerSource === 'test' ? Date.now() : 0,
    triggerSource: tested.triggerSource,
    conditionsMet: tested.conditionsMet,
    executionTimeMs: tested.executionTimeMs,
    error: tested.error,
    actions: tested.actions,
  };
  return !stored || candidate.at >= stored.at ? candidate : stored;
}

function RunBadge({
  run,
  urgent,
}: {
  run: (AutomationRun & { automated?: boolean }) | null;
  urgent: boolean;
}) {
  const { t } = useTranslation('automations');

  if (!run) {
    return (
      <Badge variant="outline">
        <History className="size-3" /> {t('meta.lastTrigger', { when: formatRelative(null) })}
      </Badge>
    );
  }
  if (!run.conditionsMet) {
    return (
      <Badge variant="warning">
        <Clock className="size-3" /> {t('status.conditionsNotMet')}
      </Badge>
    );
  }
  if (run.error) {
    return (
      <Badge variant="danger">
        <TriangleAlert className="size-3" /> {t('status.error', { message: run.error })}
      </Badge>
    );
  }
  return (
    <Badge variant={urgent ? 'success' : 'outline'}>
      <Zap className="size-3" /> {t('status.success', { ms: run.executionTimeMs })}
    </Badge>
  );
}

function TriggerSummary({ automation }: { automation: Automation }) {
  const { t } = useTranslation('automations');
  // I gruppi vuoti non contano: il motore li ignora (non sono un "sempre vero").
  const groups = [automation.conditions, ...automation.conditionGroups].filter(
    (group) => group.length > 0,
  );
  const conditionCount = groups.reduce((total, group) => total + group.length, 0);
  const scenarioCount = automation.actions.filter((action) => action.type === 'scenario').length;
  const conditionLabel =
    conditionCount === 0
      ? t('badges.noConditions')
      : t('badges.conditions', { count: conditionCount });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline">
        <TriggerIcon type={automation.triggerType} className="size-3" />
        {t(`trigger.${automation.triggerType}`)}
      </Badge>
      <Badge variant="neutral">{conditionLabel}</Badge>
      {groups.length > 1 ? (
        <Badge variant="accent">{t('badges.groupsWithOr', { count: groups.length })}</Badge>
      ) : null}
      <Badge variant="neutral">
        {t('badges.actions', { count: automation.actions.length })}
      </Badge>
      {scenarioCount > 0 ? (
        <Badge variant="outline">{t('badges.scenarios', { count: scenarioCount })}</Badge>
      ) : null}
      {!automation.isActive ? <Badge variant="outline">{t('badges.inactive')}</Badge> : null}
      {automation.invalidReason ? (
        <Badge variant="danger">{t('badges.invalid')}</Badge>
      ) : null}
    </div>
  );
}

/** Cronologia: una riga per esecuzione, con le azioni scomposte. */
function LogsDialog({
  automation,
  onClose,
}: {
  automation: Automation | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('automations');
  const { data: logs, isPending } = useAutomationLogs(automation?.id ?? null, 10);

  return (
    <Dialog
      open={automation !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {automation ? (
        <DialogContent className="max-h-[92dvh] w-[min(94vw,42rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('logs.title', { name: automation.name })}</DialogTitle>
            <DialogDescription>{t('logs.description')}</DialogDescription>
          </DialogHeader>

          {isPending ? (
            <p className="mt-4 text-xs text-fg-subtle">{t('status.running')}</p>
          ) : (logs?.length ?? 0) === 0 ? (
            <p className="mt-4 rounded-2xl border border-dashed border-line p-4 text-center text-xs text-fg-subtle">
              {t('logs.empty')}
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {logs?.map((entry: AutomationLogEntry) => (
                <li
                  key={entry.id}
                  className="rounded-2xl border border-line bg-panel-2/60 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-fg">
                      {formatTime(new Date(entry.triggeredAt))}
                    </span>
                    <Badge variant={entry.conditionsMet ? 'success' : 'warning'}>
                      {entry.conditionsMet
                        ? t('status.success', { ms: entry.executionTimeMs })
                        : t('status.conditionsNotMet')}
                    </Badge>
                    {entry.error ? (
                      <Badge variant="danger">{t('status.error', { message: entry.error })}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[10px] text-fg-subtle">
                    {t('logs.source', { source: entry.triggerSource })}
                  </p>
                  {(entry.actions?.length ?? 0) === 0 ? (
                    <p className="mt-1 text-[10px] text-fg-subtle">{t('logs.noActions')}</p>
                  ) : (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {entry.actions?.map((action, index) => (
                        <LoggedAction key={`${entry.id}-${index}`} action={action} />
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * Tab Automazioni: elenco delle regole con interruttore rapido, esecuzione di
 * prova e storico dell'ultimo trigger scattato.
 *
 * Il pannello è solo un'amministrazione: la valutazione e i comandi vivono nel
 * motore del backend, quindi questa vista può stare chiusa senza conseguenze.
 */
export function AutomationsTab() {
  const { t } = useTranslation('automations');
  const { data: automations, isPending, isError } = useAutomations();
  const devices = useDevices();
  const toggle = useToggleAutomation();
  const test = useTestAutomation();
  const remove = useDeleteAutomation();
  const pushToast = useToastStore((state) => state.push);

  const [editing, setEditing] = useState<{ automation?: Automation } | null>(null);
  const [logsFor, setLogsFor] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, AutomationTestExecution>>({});

  const list = automations ?? [];

  const changeActive = (automation: Automation, isActive: boolean): void => {
    toggle.mutate(
      { id: automation.id, isActive },
      {
        onError: (cause) =>
          pushToast({
            title: t('toast.toggleFailed'),
            description: cause instanceof Error ? cause.message : undefined,
            tone: 'error',
          }),
      },
    );
  };

  const runTest = (automation: Automation): void => {
    test.mutate(automation.id, {
      onSuccess: ({ execution }) => {
        setTested((previous) => ({ ...previous, [automation.id]: execution }));
        pushToast(
          execution.conditionsMet && !execution.error
            ? {
                title: t('toast.testSuccess', { ms: execution.executionTimeMs }),
                description: automation.name,
                tone: 'success',
              }
            : {
                title: execution.error ? t('toast.testFailed') : t('toast.testConditions'),
                description: execution.error ?? automation.name,
                tone: execution.error ? 'error' : 'info',
              },
        );
      },
      onError: (cause) =>
        pushToast({
          title: t('toast.testFailed'),
          description: cause instanceof Error ? cause.message : undefined,
          tone: 'error',
        }),
    });
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
      pushToast({
        title: t('toast.deleted'),
        description: deleting.name,
        tone: 'success',
      });
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : t('toast.deleteFailed'));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-[11px] leading-relaxed text-fg-subtle">
          {t('description')}
        </p>
        <Button type="button" variant="primary" size="sm" onClick={() => setEditing({})}>
          <Plus /> {t('create')}
        </Button>
      </div>

      {isError ? (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {t('error')}
        </p>
      ) : null}

      {isPending ? (
        <p className="text-xs text-fg-subtle">{t('status.running')}</p>
      ) : list.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">
          {t('empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {list.map((automation) => {
            const run = latestRun(automation, tested[automation.id]);
            return (
              <article
                key={automation.id}
                className={cn(
                  'flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4',
                  !automation.isActive && 'opacity-70',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{automation.name}</p>
                    {automation.description ? (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-fg-subtle">
                        {automation.description}
                      </p>
                    ) : null}
                    <p className="mt-1 truncate font-mono text-[10px] text-fg-subtle">
                      {automation.summary}
                    </p>
                  </div>
                  <Switch
                    checked={automation.isActive}
                    onCheckedChange={(value) => changeActive(automation, value)}
                    aria-label={t('switch.label', { name: automation.name })}
                  />
                </div>

                <TriggerSummary automation={automation} />

                <div className="flex flex-wrap items-center gap-2">
                  <RunBadge run={run} urgent={Boolean(tested[automation.id])} />
                  <span className="text-[10px] text-fg-subtle">
                    {t('meta.lastTrigger', {
                      when: formatRelative(automation.lastTriggeredAt),
                    })}
                    {automation.executionCount > 0
                      ? ` · ${t('meta.executions', { count: automation.executionCount })}`
                      : ''}
                  </span>
                </div>

                {automation.invalidReason ? (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[10px] leading-relaxed text-warning"
                  >
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    {automation.invalidReason}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={test.isPending}
                    onClick={() => runTest(automation)}
                  >
                    {automation.triggerType === 'sun_event' ? <Sunrise /> : <Zap />}
                    {test.isPending && test.variables === automation.id
                      ? t('action.testing')
                      : t('action.test')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLogsFor(automation)}
                  >
                    <History /> {t('action.history')}
                  </Button>
                  <div className="ml-auto flex items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('action.edit', { name: automation.name })}
                      title={t('action.edit', { name: automation.name })}
                      onClick={() => setEditing({ automation })}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('action.delete', { name: automation.name })}
                      title={t('action.delete', { name: automation.name })}
                      className="text-danger hover:bg-danger/10 hover:text-danger"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleting(automation);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <p className="flex items-start gap-2 rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
        <Sunset className="mt-0.5 size-3.5 shrink-0 text-warning" />
        {t('warning')}
      </p>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing ? (
          <DialogContent className="max-h-[92dvh] w-[min(96vw,52rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editing.automation ? t('form.editTitle') : t('form.createTitle')}
              </DialogTitle>
              <DialogDescription>{t('form.description')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4">
              <AutomationForm
                {...(editing.automation ? { automation: editing.automation } : {})}
                devices={devices}
                onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  pushToast({
                    title: t('toast.saved'),
                    description: t('toast.savedDescription'),
                    tone: 'success',
                  });
                }}
              />
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      <LogsDialog automation={logsFor} onClose={() => setLogsFor(null)} />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        {deleting ? (
          <DialogContent className="w-[min(92vw,26rem)]">
            <DialogHeader>
              <DialogTitle>{t('deleteDialog.title', { name: deleting.name })}</DialogTitle>
              <DialogDescription>{t('deleteDialog.description')}</DialogDescription>
            </DialogHeader>
            {deleteError ? (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
              >
                {deleteError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDeleting(null)}
                disabled={remove.isPending}
              >
                {t('action.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void confirmDelete()}
                disabled={remove.isPending}
              >
                {remove.isPending ? t('deleteDialog.busy') : t('deleteDialog.confirm')}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
