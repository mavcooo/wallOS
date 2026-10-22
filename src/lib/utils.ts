import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const nf = new Intl.NumberFormat('it-IT');

export function formatWatts(watts: number): string {
  if (watts >= 1000) {
    return `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(watts / 1000)} kW`;
  }
  return `${nf.format(Math.round(watts))} W`;
}

export function formatKwh(kwh: number, digits = 2): string {
  return `${new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(kwh)} kWh`;
}

export function formatTemp(value: number): string {
  return `${new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)}°`;
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatDate(date: Date): string {
  const weekday = date.toLocaleDateString('it-IT', { weekday: 'long' });
  const rest = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${rest}`;
}

export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return 'mai';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'adesso';
  if (seconds < 60) return `${seconds}s fa`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m fa`;
  return `${Math.round(minutes / 60)}h fa`;
}

export function percent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
