import { useClock } from '@/hooks/useClock';
import { formatDate, formatTime } from '@/lib/utils';

export function Clock() {
  const now = useClock(1000);
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="tabular text-3xl font-light tracking-tight text-fg lg:text-4xl">
        {formatTime(now)}
      </span>
      <span className="mt-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        {formatDate(now)}
      </span>
    </div>
  );
}
