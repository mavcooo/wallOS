import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Switch con stato leggibile anche senza distinguere i colori:
 * `|` sul lato libero quando è ON, `O` quando è OFF. Gli indicatori sono
 * decorativi (`aria-hidden`): lo stato autorevole resta `aria-checked` di
 * Radix, quindi screen reader e test non dipendono dai glifi.
 *
 * I `data-slot` sono il contratto con il tema alto contrasto (index.css):
 * track con bordo bianco 2px, pollice più grande e controbordato.
 */
export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch-track"
      className={cn(
        'group peer relative inline-flex h-8 w-14 shrink-0 cursor-pointer items-center rounded-full border-2 border-line-strong transition-colors',
        'data-[state=checked]:bg-accent data-[state=unchecked]:bg-elevated',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {/* ON: barra verticale nel lato lasciato libero dal pollice. */}
      <span
        data-slot="switch-indicator"
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1.5 flex items-center opacity-0 transition-opacity group-data-[state=checked]:opacity-100"
      >
        <span className="h-3 w-[3px] rounded-full bg-accent-fg" />
      </span>
      {/* OFF: cerchio vuoto nel lato lasciato libero dal pollice. */}
      <span
        data-slot="switch-indicator"
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center opacity-100 transition-opacity group-data-[state=checked]:opacity-0"
      >
        <span className="size-2 rounded-full border-2 border-fg-muted" />
      </span>
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-6 rounded-full border-2 border-line-strong bg-fg shadow-lg ring-0 transition-transform',
          'data-[state=checked]:translate-x-6 data-[state=unchecked]:translate-x-1',
          'data-[state=checked]:border-transparent data-[state=checked]:bg-accent-fg',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
