/**
 * Identità del pannello a parete (`kiosk_id`).
 *
 * Serve a due cose che non coincidono con il profilo di accesso: il tablet ha
 * una configurazione hardware propria (`kiosk_displays`, vedi
 * `useKioskBootstrap`) e le modifiche fatte dall'amministratore devono
 * raggiungere *quel* display via MQTT.
 *
 * L'id deve sopravvivere a tutto ciò che azzera un browser: riavvio in
 * incognito, pulizia cache, ripristino del tablet. Per questo vive in **due**
 * posti:
 * - `localStorage` (`wallos_kiosk_id`), letto per primo perché è la via più
 *   rapida;
 * - un **cookie persistente** con scadenza decennale (`SameSite=Strict`,
 *   `Path=/`), che sopravvive alla cancellazione del solo storage locale.
 *
 * Non è un segreto: chi legge il cookie può solo chiedere la configurazione di
 * quel display, e il server verifica comunque il profilo autenticato
 * (`users.kiosk_device_id`).
 */

export const KIOSK_ID_STORAGE_KEY = 'wallos_kiosk_id';
export const KIOSK_ID_COOKIE = 'wallos_kiosk_id';

/** Dieci anni: un tablet a parete non deve ri-registrarsi a ogni scadenza. */
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365 * 10;

/**
 * Stesso formato accettato dalla route e dal CHECK della tabella: nessuno spazio
 * o slash, perché l'id finisce anche in un topic MQTT.
 */
const KIOSK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function sanitizeKioskId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return KIOSK_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const entry = part.trim();
    if (entry.startsWith(prefix)) return decodeURIComponent(entry.slice(prefix.length));
  }
  return null;
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage disabilitato (Safari in navigazione privata): resta il cookie.
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Nessuna eccezione: il cookie è sufficiente.
  }
}

function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  // `Secure` solo su HTTPS: su HTTP in LAN il browser scarterebbe il cookie.
  const secure = globalThis.location?.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE_SEC}; Path=/; SameSite=Strict${secure}`;
}

/** `kiosk_<uuid v4>`: leggibile a occhio e univoco senza coordinamento. */
export function generateKioskId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : // Fallback per browser/ambienti senza `randomUUID` (test, WebView vecchie).
        Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
  return `kiosk_${uuid}`;
}

let cached: string | null = null;

/**
 * Id del pannello, creandolo al primo avvio. Il valore viene scritto in
 * entrambi i contenitori anche quando era presente in uno solo, così dopo la
 * prima visita sono sempre allineati.
 */
export function getKioskId(): string {
  if (cached) return cached;

  const existing = sanitizeKioskId(readStorage(KIOSK_ID_STORAGE_KEY)) ?? sanitizeKioskId(readCookie(KIOSK_ID_COOKIE));
  const id = existing ?? generateKioskId();

  writeStorage(KIOSK_ID_STORAGE_KEY, id);
  writeCookie(KIOSK_ID_COOKIE, id);
  cached = id;
  return id;
}

/**
 * Sostituisce l'id (rinomina o id scelto dall'amministratore, es.
 * `tablet_ingresso`). Restituisce `null` se il formato non è valido: la UI
 * mostra l'errore senza toccare l'identità in uso.
 */
export function setKioskId(value: string): string | null {
  const id = sanitizeKioskId(value);
  if (!id) return null;
  writeStorage(KIOSK_ID_STORAGE_KEY, id);
  writeCookie(KIOSK_ID_COOKIE, id);
  cached = id;
  return id;
}

/** Solo per i test: dimentica il valore memorizzato in memoria. */
export function resetKioskIdCache(): void {
  cached = null;
}
