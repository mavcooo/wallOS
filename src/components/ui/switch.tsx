import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-8 w-14 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'data-[state=checked]:bg-accent data-[state=unchecked]:bg-elevated',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-6 rounded-full bg-fg shadow-lg ring-0 transition-transform',
          'data-[state=checked]:translate-x-6 data-[state=unchecked]:translate-x-1',
          'data-[state=checked]:bg-accent-fg',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
