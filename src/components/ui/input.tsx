import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg',
        'placeholder:text-fg-subtle transition-colors',
        'focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        type === 'number' && 'no-spin',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-xs font-medium text-fg-muted', className)}
      {...props}
    />
  );
}
