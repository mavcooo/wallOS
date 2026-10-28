import { Building2, Layers, Lightbulb, ShieldAlert, type LucideIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { floorSignals } from '@/lib/floorplan';
import { cn } from '@/lib/utils';
import { useHomeStore } from '@/store/homeStore';
import type { Floor } from '@/types/floorplan';

/** Icone del catalogo Lucide usate dai piani; fallback `Layers`. */
const FLOOR_ICONS: Record<string, LucideIcon> = {
  Layers,
  Building2,
};

interface FloorSelectorProps {
  floors: readonly Floor[];
  activeFloorId: string | null;
  onSelect: (floorId: string) => void;
  className?: string;
}

/**
 * Selettore dei piani a tab orizzontali.
 *
 * - pulsanti da **almeno 48 px** di altezza, pensati per il dito su un
 *   pannello a parete;
 * - chip con contatori calcolati in tempo reale: luci accese e allarmi attivi
 *   (fumo, perdite, intrusione) del piano, così si vede dove intervenire senza
 *   aprirlo;
 * - l'ordine arriva da PostgreSQL (`level_order`), nessuna logica nel client.
 *
 * I contatori sono letti come numeri con `useShallow`: arriva telemetria ogni
 * pochi secondi, ma il selettore si ridisegna solo quando un conteggio cambia.
 */
export const FloorSelector = memo(function FloorSelector({
  floors,
  activeFloorId,
  onSelect,
  className,
}: FloorSelectorProps) {
  const { t } = useTranslation('floorplan');

  // Array piatto [luci, allarmi, luci, allarmi, …]: shallow-compare stabile.
  const counters = useHomeStore(
    useShallow((state) =>
      floors.flatMap((floor) => {
        const signals = floorSignals(floor, state.deviceStates);
        return [signals.lightsOn, signals.alarms];
      }),
    ),
  );

  if (floors.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label={t('floors.aria')}
      className={cn('flex flex-wrap items-stretch gap-2', className)}
      // Nessuno swipe di pagina quando si cambia piano: il tocco è locale.
      data-swipe-ignore
    >
      {floors.map((floor, index) => {
        const active = floor.id === activeFloorId;
        const lightsOn = counters[index * 2] ?? 0;
        const alarms = counters[index * 2 + 1] ?? 0;
        const Icon = FLOOR_ICONS[floor.icon] ?? Layers;

        return (
          <button
            key={floor.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls="schematic-floor-canvas"
            onClick={() => {
              if (!active) onSelect(floor.id);
            }}
            className={cn(
              'flex min-h-12 shrink-0 items-center gap-3 rounded-2xl border px-3.5 py-2 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              active
                ? 'border-accent/50 bg-accent-soft text-fg'
                : 'border-line bg-panel text-fg-muted hover:border-line-strong hover:text-fg',
            )}
          >
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-xl border',
                active
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-line bg-panel-2 text-fg-subtle',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </span>

            <span className="min-w-0">
              <span className="block truncate text-sm font-medium leading-tight">
                {floor.name}
              </span>
              <span className="mt-0.5 flex items-center gap-2.5 text-[10px] leading-none">
                <span
                  className={cn(
                    'flex items-center gap-1 tabular',
                    lightsOn > 0 ? 'text-warning' : 'text-fg-subtle',
                  )}
                >
                  <Lightbulb className="size-3" aria-hidden="true" />
                  {t('floors.lights', { count: lightsOn })}
                </span>
                <span
                  className={cn(
                    'flex items-center gap-1 tabular',
                    alarms > 0 ? 'text-danger' : 'text-fg-subtle',
                  )}
                >
                  <ShieldAlert
                    className={cn('size-3', alarms > 0 && 'animate-pulse motion-reduce:animate-none')}
                    aria-hidden="true"
                  />
                  {t('floors.alarms', { count: alarms })}
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
});
