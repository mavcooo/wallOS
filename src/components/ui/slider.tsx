import * as SliderPrimitive from '@radix-ui/react-slider';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export function Slider({
  className,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root>) {
  const { t } = useTranslation();
  // L'aria-label passata dal chiamante descrive il cursore; il default resta
  // tradotto invece di essere un literal italiano nel componente generico.
  const thumbLabel =
    typeof props['aria-label'] === 'string' ? props['aria-label'] : t('sliderLevel');

  return (
    <SliderPrimitive.Root
      className={cn(
        // `ignore-swipe`: trascinare lo slider non deve cambiare pagina/stanza.
        // `px-1`: il thumb è centrato sull'estremo della track, quindi metà
        // del suo diametro esce dal box dello slider. Con 4px di inset il
        // pollice resta dentro il padding della card (16px) anche a 40px di
        // diametro del tema alto contrasto: niente clipping né scroll laterale
        // durante il drag.
        'ignore-swipe relative flex h-11 w-full touch-none select-none items-center px-1',
        className,
      )}
      {...props}
    >
      {/* `data-slot` è il contratto con il tema alto contrasto: il track
          inattivo riceve bordo bianco 2px e il thumb cresce a 40px. */}
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-2.5 w-full grow overflow-hidden rounded-full border border-line-strong bg-elevated"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute h-full rounded-full bg-accent"
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        className={cn(
          'block size-8 rounded-full border-4 border-panel bg-accent shadow-md transition-transform',
          'active:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50',
        )}
        aria-label={thumbLabel}
      />
    </SliderPrimitive.Root>
  );
}
