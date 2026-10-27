import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import enAuth from './locales/en/auth.json';
import enAutomations from './locales/en/automations.json';
import enCommon from './locales/en/common.json';
import enDevices from './locales/en/devices.json';
import enEnergy from './locales/en/energy.json';
import enSettings from './locales/en/settings.json';
import itAuth from './locales/it/auth.json';
import itAutomations from './locales/it/automations.json';
import itCommon from './locales/it/common.json';
import itDevices from './locales/it/devices.json';
import itEnergy from './locales/it/energy.json';
import itSettings from './locales/it/settings.json';

/** Lingua di fallback: il pannello nasce in italiano, le chiavi mancanti
 * nell'altra lingua ricadono qui invece di mostrare l'id della chiave. */
export const FALLBACK_LANGUAGE = 'it' as const;

export const SUPPORTED_LANGUAGES = ['it', 'en'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Chiave localStorage scritta da i18next-browser-languagedetector: sopravvive
 * al riavvio del tablet kiosk, che non ha un profilo utente separato. */
export const LANGUAGE_STORAGE_KEY = 'domus.language';

export const resources = {
  it: {
    common: itCommon,
    devices: itDevices,
    energy: itEnergy,
    settings: itSettings,
    auth: itAuth,
    automations: itAutomations,
  },
  en: {
    common: enCommon,
    devices: enDevices,
    energy: enEnergy,
    settings: enSettings,
    auth: enAuth,
    automations: enAutomations,
  },
} as const;

export const NAMESPACES = [
  'common',
  'devices',
  'energy',
  'settings',
  'auth',
  'automations',
] as const;

/** Locale BCP 47 usata da Intl: 'en' → inglese britannico, con date
 * giorno-mese e orologio a 24 ore come sul pannello italiano. */
export function activeLocale(): string {
  return i18n.resolvedLanguage?.startsWith('en') ? 'en-GB' : 'it-IT';
}

export function isSupportedLanguage(value: string | undefined | null): value is SupportedLanguage {
  return value === 'it' || value === 'en';
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // 'it-IT' dal browser deve risolvere sul dizionario 'it'.
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    defaultNS: 'common',
    fallbackNS: 'common',
    ns: [...NAMESPACES],
    // Le risorse sono inline: l'init è sincrono e il primo render ha già le
    // stringhe, senza un flash di chiavi non tradotte.
    initAsync: false,
    detection: {
      // Solo la preferenza salvata: nessun auto-switch sul navigator, così un
      // pannello appena installato resta nella lingua di fallback.
      order: ['localStorage'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: {
      // React fa già l'escaping: i valori interpolati non sono HTML.
      escapeValue: false,
    },
    returnNull: false,
  });

i18n.on('languageChanged', (language) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language;
  }
});

export default i18n;

/**
 * Type augmentation di react-i18next: `t()` accetta solo chiavi presenti nei
 * dizionari italiani e `useTranslation('energy')` limita le chiavi al namespace.
 * Una chiave inesistente (`t('energy.invalidKey')`) è un errore di compilazione.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof resources)['it'];
    returnNull: false;
  }
}
