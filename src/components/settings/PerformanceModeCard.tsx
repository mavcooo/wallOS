import { Gauge } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { usePerformanceMode } from '@/hooks/usePerformanceMode';

/**
 * Interruttore per i pannelli lenti: gli override CSS vivono in `index.css`
 * sotto `html[data-performance-mode='true']`, quindi la UI cambia subito senza
 * rimontare i componenti.
 */
export function PerformanceModeCard() {
  const { t } = useTranslation('settings');
  const { enabled, setEnabled } = usePerformanceMode();

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-4 text-accent" /> {t('performance.title')}
          </CardTitle>
          <CardDescription className="mt-1">{t('performance.description')}</CardDescription>
        </div>
        <Badge variant={enabled ? 'accent' : 'neutral'}>
          {enabled ? t('performance.statusOn') : t('performance.statusOff')}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-fg">{t('performance.label')}</p>
            <p className="text-[10px] leading-relaxed text-fg-subtle">
              {t('performance.hint')}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('performance.label')}
          />
        </div>
        <p
          className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-[10px] leading-relaxed text-fg-subtle"
          data-testid="performance-mode-note"
        >
          {t('performance.note')}
        </p>
      </CardContent>
    </Card>
  );
}
