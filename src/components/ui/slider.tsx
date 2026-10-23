import * as SliderPrimitive from '@radix-ui/react-slider';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Slider({
  className,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        // `ignore-swipe`: trascinare lo slider non deve cambiare pagina/stanza.
        'ignore-swipe relative flex h-11 w-full touch-none select-none items-center',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2.5 w-full grow overflow-hidden rounded-full bg-elevated">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          'block size-8 rounded-full border-4 border-panel bg-accent shadow-md transition-transform',
          'active:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50',
        )}
        aria-label="Livello"
      />
    </SliderPrimitive.Root>
  );
}
