import { Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAutomationActivity } from '@/hooks/useAutomations';
import { cn, formatRelative } from '@/lib/utils';
import type { DeviceAutomationActivity } from '@/types/automations';

/**
 * Oltre questa finestra il comando è storia, non più la spiegazione di uno
 * stato: un badge permanente "Buonanotte" su una luce riaccesa a mano sarebbe
 * un'informazione sbagliata. La cronologia completa resta nel tab Automazioni.
 */
export const ACTIVITY_FRESH_MS = 2 * 60 * 60_000;

/** Attività del device, se recente: funzione pura per il test del badge. */
export function automationActivityFor(
  activity: readonly DeviceAutomationActivity[] | undefined,
  deviceId: string,
  now: number = Date.now(),
): DeviceAutomationActivity | null {
  const entry = activity?.find((item) => item.deviceId === deviceId);
  if (!entry) return null;
  return now - entry.at <= ACTIVITY_FRESH_MS ? entry : null;
}

/**
 * Badge "chi ha comandato questa luce?".
 *
 * Il motore di automazioni gira nel server: quando una regola accende un
 * dispositivo, sul pannello il cambiamento arriva dalla telemetria senza che
 * nessuno abbia toccato lo schermo. Il badge dice da dove è arrivato il comando
 * (regola, eventuale scenario e orario), e sparisce quando il comando è troppo
 * vecchio per spiegare lo stato attuale.
 */
export function AutomationBadge({
  deviceId,
  className,
}: {
  deviceId: string;
  className?: string;
}) {
  const { t } = useTranslation('devices');
  const { data } = useAutomationActivity();
  const entry = automationActivityFor(data, deviceId);
  if (!entry) return null;

  const when = formatRelative(entry.at);
  const hint = entry.scenarioLabel
    ? t('automation.scenarioHint', {
        name: entry.automationName,
        scenario: entry.scenarioLabel,
        when,
      })
    : t('automation.hint', { name: entry.automationName, when });

  return (
    <span
      role="status"
      title={hint}
      aria-label={hint}
      data-automation={entry.automationId}
      className={cn(
        'pointer-events-none inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full',
        'border border-accent/35 bg-panel/85 px-2 py-0.5 text-[10px] font-medium text-accent backdrop-blur',
        className,
      )}
    >
      <Zap className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{entry.automationName}</span>
    </span>
  );
}
