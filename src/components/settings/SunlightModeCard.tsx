import { Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useHighContrast } from '@/hooks/useHighContrast';
import { AMBIENT_LUX_THRESHOLD, type ContrastPreference } from '@/lib/contrast';
import { cn } from '@/lib/utils';

/** `auto` segue sistema e sensore, le altre due sono scelte esplicite. */
const MODES: readonly ContrastPreference[] = ['auto', 'on', 'off'];

export function SunlightModeCard() {
  const { t } = useTranslation('settings');
  const {
    enabled,
    preference,
    reason,
    systemHighContrast,
    ambientLux,
    ambientSupported,
    setPreference,
  } = useHighContrast();

  const reasonText = enabled
    ? reason === 'system'
      ? t('contrast.reasons.system')
      : reason === 'ambient'
        ? t('contrast.reasons.ambient', { lux: Math.round(ambientLux ?? 0) })
        : t('contrast.reasons.manual')
    : !ambientSupported
      ? t('contrast.reasons.unsupported')
      : ambientLux === null
        ? t('contrast.reasons.noReading')
        : t('contrast.reasons.watching', {
            lux: Math.round(ambientLux),
            threshold: AMBIENT_LUX_THRESHOLD,
          });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sun className="size-4 text-accent" /> {t('contrast.title')}
          </CardTitle>
          <CardDescription className="mt-1">{t('contrast.description')}</CardDescription>
        </div>
        <Badge variant={enabled ? 'accent' : 'neutral'}>
          {enabled ? t('contrast.statusOn') : t('contrast.statusOff')}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel-2 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-fg">{t('contrast.label')}</p>
            <p className="text-[10px] leading-relaxed text-fg-subtle">{t('contrast.hint')}</p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => setPreference(checked ? 'on' : 'off')}
            aria-label={t('contrast.label')}
          />
        </div>

        <div
          role="group"
          aria-label={t('contrast.modeLabel')}
          className="grid grid-cols-3 gap-1.5"
        >
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={preference === mode}
              onClick={() => setPreference(mode)}
              className={cn(
                'h-10 rounded-xl border text-[11px] font-medium transition-colors',
                preference === mode
                  ? 'border-accent/40 bg-accent-soft text-accent'
                  : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
              )}
            >
              {t(`contrast.modes.${mode}`)}
            </button>
          ))}
        </div>

        <p
          className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-[10px] leading-relaxed text-fg-subtle"
          data-testid="contrast-reason"
        >
          {reasonText}
          {systemHighContrast && reason !== 'system' ? ` ${t('contrast.reasons.systemHint')}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}
