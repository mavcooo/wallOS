import { Check, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isSupportedLanguage, type SupportedLanguage } from '@/i18n';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToastStore } from '@/store/toastStore';

interface LanguageOption {
  code: SupportedLanguage;
  /** Endonimo: "Italiano" e "English" restano scritti nella propria lingua,
   * così chi non capisce la lingua corrente trova comunque la sua. */
  label: string;
  flag: string;
}

const LANGUAGES: readonly LanguageOption[] = [
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
];

/**
 * Cambio lingua a caldo: `i18n.changeLanguage` notifica react-i18next, ogni
 * componente con `useTranslation` si ridisegna e il LanguageDetector salva la
 * scelta in localStorage. Nessun reload del kiosk.
 */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation('settings');
  const pushToast = useToastStore((state) => state.push);
  const current: SupportedLanguage = isSupportedLanguage(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : 'it';

  const changeLanguage = async (option: LanguageOption) => {
    if (option.code === current) return;
    await i18n.changeLanguage(option.code);
    // i18n.t, non la `t` del render precedente: il toast deve uscire già nella
    // nuova lingua.
    pushToast({
      title: i18n.t('language.changedTitle', { ns: 'settings' }),
      description: i18n.t('language.changedDescription', {
        ns: 'settings',
        language: option.label,
      }),
      tone: 'success',
    });
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Languages className="size-4 text-accent" /> {t('language.title')}
          </CardTitle>
          <CardDescription className="mt-1">{t('language.description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div
          role="group"
          aria-label={t('language.label')}
          className="grid grid-cols-2 gap-2"
        >
          {LANGUAGES.map((option) => {
            const selected = option.code === current;
            return (
              <button
                key={option.code}
                type="button"
                onClick={() => void changeLanguage(option)}
                aria-pressed={selected}
                lang={option.code}
                className={cn(
                  'flex h-14 min-w-0 items-center gap-3 rounded-xl border px-3 text-left transition-colors',
                  selected
                    ? 'border-accent/40 bg-accent-soft text-accent'
                    : 'border-line bg-panel-2 text-fg-muted hover:text-fg',
                )}
              >
                <span className="text-xl leading-none" aria-hidden>
                  {option.flag}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-semibold">{option.label}</span>
                  <span className="text-[10px] uppercase tracking-wider opacity-70">
                    {option.code.toUpperCase()}
                  </span>
                </span>
                {selected ? <Check className="ml-auto size-4 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] leading-relaxed text-fg-subtle">{t('language.hint')}</p>
      </CardContent>
    </Card>
  );
}
