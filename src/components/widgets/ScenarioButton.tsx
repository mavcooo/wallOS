import {
  Clapperboard,
  DoorOpen,
  Loader2,
  Lock,
  MoonStar,
  Sparkles,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { usePinGuard } from '@/components/kiosk/PinProvider';
import { useMqttApi } from '@/mqtt/MqttProvider';
import { cn } from '@/lib/utils';
import type { Scenario } from '@/types/device';

const ICONS: Record<string, LucideIcon> = {
  clapperboard: Clapperboard,
  moon: MoonStar,
  'door-open': DoorOpen,
  spa: Waves,
};

export function ScenarioButton({ scenario }: { scenario: Scenario }) {
  const { runScenario } = useMqttApi();
  const requestPin = usePinGuard();
  const [running, setRunning] = useState(false);
  // L'icona è un dato del DB: uno slug sconosciuto non deve rompere il widget.
  const Icon = ICONS[scenario.icon] ?? Sparkles;

  const execute = async () => {
    setRunning(true);
    try {
      await runScenario(scenario.id);
    } finally {
      setRunning(false);
    }
  };

  const handleClick = () => {
    if (scenario.protected) {
      requestPin({
        title: 'Scenario protetto',
        description: `Per attivare “${scenario.label}” inserisci il PIN del pannello.`,
        action: `${scenario.steps.length} comandi verranno inviati.`,
        onConfirm: () => {
          void execute();
        },
      });
      return;
    }
    void execute();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={running}
      className={cn(
        'group relative flex h-full min-h-[104px] flex-col items-start justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-panel p-4 text-left transition-all',
        'hover:border-line-strong hover:bg-panel-2 active:scale-[0.99] disabled:opacity-70',
      )}
    >
      <span className="flex w-full items-start justify-between">
        <span className="flex size-11 items-center justify-center rounded-xl border border-accent/20 bg-accent-soft text-accent">
          {running ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
        </span>
        {scenario.protected ? (
          <Lock className="size-3.5 text-fg-subtle" aria-label="Richiede PIN" />
        ) : null}
      </span>
      <span className="w-full">
        <span className="block text-sm font-semibold text-fg">{scenario.label}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-fg-subtle">
          {scenario.description}
        </span>
      </span>
    </button>
  );
}
