import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent/90 active:bg-accent/80',
        secondary: 'bg-elevated text-fg hover:bg-line-strong/60 active:bg-line-strong/80',
        outline: 'border border-line bg-transparent text-fg hover:bg-elevated',
        ghost: 'bg-transparent text-fg-muted hover:bg-elevated hover:text-fg',
        danger: 'bg-danger/15 text-danger hover:bg-danger/25',
      },
      size: {
        sm: 'h-9 px-3 text-xs [&_svg]:size-4',
        default: 'h-11 px-4 [&_svg]:size-4',
        lg: 'h-14 px-6 text-base [&_svg]:size-5',
        icon: 'size-11 [&_svg]:size-5',
        'icon-lg': 'size-14 [&_svg]:size-6',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

export { buttonVariants };
