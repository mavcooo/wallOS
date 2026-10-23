import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import i18n, { activeLocale } from '@/i18n';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Intl.NumberFormat è costoso da costruire: la locale cambia solo quando
// l'utente cambia lingua, quindi la cache resta valida per tutta la sessione.
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = activeLocale();
  const cacheKey = `${locale}:${key}`;
  let format = numberFormats.get(cacheKey);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(cacheKey, format);
  }
  return format;
}

export function formatWatts(watts: number): string {
  if (watts >= 1000) {
    return `${numberFormat('kw', { maximumFractionDigits: 2 }).format(watts / 1000)} kW`;
  }
  return `${numberFormat('w', {}).format(Math.round(watts))} W`;
}

export function formatKwh(kwh: number, digits = 2): string {
  return `${numberFormat(`kwh-${digits}`, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(kwh)} kWh`;
}

export function formatTemp(value: number): string {
  return `${numberFormat('temp', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)}°`;
}

/** Orologio del pannello: sempre 24 ore, come i display a parete. */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString(activeLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatDate(date: Date): string {
  const locale = activeLocale();
  const weekday = date.toLocaleDateString(locale, { weekday: 'long' });
  const rest = date.toLocaleDateString(locale, { day: 'numeric', month: 'long' });
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${rest}`;
}

export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return i18n.t('time.never');
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return i18n.t('time.now');
  if (seconds < 60) return i18n.t('time.secondsAgo', { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return i18n.t('time.minutesAgo', { count: minutes });
  return i18n.t('time.hoursAgo', { count: Math.round(minutes / 60) });
}

export function percent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
