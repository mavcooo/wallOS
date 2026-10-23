import type { ReactNode } from 'react';

import { Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export const selectClass = cn(
  'h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg',
  'focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20',
);

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <Label>{label}</Label>
      {children}
      {hint ? <span className="text-[10px] leading-relaxed text-fg-subtle">{hint}</span> : null}
    </label>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg">{label}</p>
        {hint ? <p className="mt-0.5 text-[10px] text-fg-subtle">{hint}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
    >
      {message}
    </p>
  );
}
