import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export interface CarouselDotsProps {
  count: number;
  activeIndex: number;
  /** Etichetta accessibile: "Pagina" per le schermate, "Stanza" per il carosello. */
  label: string;
  /** Se presente i pallini diventano selettori touch (area di 28 px). */
  onSelect?(index: number): void;
  className?: string;
}

/**
 * Indicatore discreto della posizione corrente. Solo `transform`/`width` su
 * pochi elementi: nessun impatto misurabile sul frame rate dei tablet kiosk.
 */
export function CarouselDots({
  count,
  activeIndex,
  label,
  onSelect,
  className,
}: CarouselDotsProps) {
  const { t } = useTranslation();
  if (count < 2) return null;
  const active = Math.min(Math.max(activeIndex, 0), count - 1);

  return (
    <div
      className={cn('flex items-center justify-center gap-0.5', className)}
      role={onSelect ? 'group' : 'img'}
      aria-label={
        onSelect ? label : t('swipe.position', { label, index: active + 1, count })
      }
      data-swipe-ignore
    >
      {Array.from({ length: count }, (_, index) => {
        const isActive = index === active;
        const dot = (
          <span
            className={cn(
              'block h-1.5 rounded-full transition-[width,background-color] duration-200',
              isActive ? 'w-5 bg-accent' : 'w-1.5 bg-line-strong',
            )}
          />
        );

        if (!onSelect) {
          return (
            <span key={index} className="flex h-6 w-4 items-center justify-center" aria-hidden="true">
              {dot}
            </span>
          );
        }

        return (
          <button
            key={index}
            type="button"
            onClick={() => onSelect(index)}
            aria-label={t('swipe.goTo', { label, index: index + 1, count })}
            aria-current={isActive ? 'true' : undefined}
            className="flex size-7 items-center justify-center rounded-full transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {dot}
          </button>
        );
      })}
    </div>
  );
}
