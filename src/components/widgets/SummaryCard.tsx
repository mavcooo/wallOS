import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

interface SummaryCardProps {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  tone?: 'accent' | 'warning' | 'danger' | 'neutral';
  className?: string;
}

const TONES = {
  accent: 'border-accent/20 bg-accent-soft text-accent',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  danger: 'border-danger/25 bg-danger/10 text-danger',
  neutral: 'border-line bg-panel-2 text-fg-muted',
} as const;

export function SummaryCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  className,
}: SummaryCardProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-panel p-4',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">{label}</p>
        <p className="tabular mt-2 truncate text-2xl font-light leading-none text-fg">{value}</p>
        <p className="mt-1.5 truncate text-[11px] text-fg-muted">{hint}</p>
      </div>
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl border',
          TONES[tone],
        )}
      >
        <Icon className="size-5" />
      </span>
    </div>
  );
}
