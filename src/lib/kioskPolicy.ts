/**
 * Preferenze del display che non vivono in uno store React ma devono essere
 * leggibili anche fuori dal render (guardia PIN dei widget, orientamento
 * dichiarato dal server).
 *
 * Tenute qui e non in `homeStore` perché sono **server-state**: il valore
 * autorevole è la riga in `kiosk_displays`, applicata da `useKioskBootstrap` e
 * `useKioskSync`. Persisterle nel localStorage creerebbe una seconda verità che
 * vince su quella centralizzata.
 */

import type { KioskOrientation } from '@/types/kiosk';

/** Attributo su `<html>` con l'orientamento dichiarato dal server. */
export const KIOSK_ORIENTATION_ATTRIBUTE = 'kioskOrientation';

let pinRequired = true;

/**
 * `pin_required` del display: se l'amministratore lo disattiva, i comandi sui
 * device protetti partono senza PIN **su questo pannello**. Le azioni
 * amministrative (broker, profili, cambio utente) restano protette: quella
 * impostazione non è un interruttore di sicurezza globale.
 */
export function setKioskPinRequired(value: boolean): void {
  pinRequired = value;
}

export function isKioskPinRequired(): boolean {
  return pinRequired;
}

/** Solo per i test: torna al default (PIN richiesto). */
export function resetKioskPinRequired(): void {
  pinRequired = true;
}

/**
 * Applica l'orientamento: l'attributo su `<html>` è il contratto per il CSS,
 * mentre su PWA installate prova anche il lock dell'API Screen Orientation
 * (fallisce senza fullscreen o su browser che non la supportano: degradazione
 * silenziosa, il tablet resta come lo tiene l'utente).
 */
export function applyKioskOrientation(orientation: KioskOrientation): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset[KIOSK_ORIENTATION_ATTRIBUTE] = orientation;

  const screenOrientation = (
    globalThis.screen as (Screen & { orientation?: { lock?: (value: string) => Promise<void> } }) | undefined
  )?.orientation;
  if (typeof screenOrientation?.lock !== 'function') return;
  try {
    void screenOrientation.lock(orientation).catch(() => undefined);
  } catch {
    // `lock` può lanciare in modo sincrono (permessi, fullscreen mancante).
  }
}
