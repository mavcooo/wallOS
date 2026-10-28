/**
 * UUID v4 per chiavi UI, id di comando e log diagnostici.
 *
 * `crypto.randomUUID()` è disponibile **solo in secure context**: HTTPS oppure
 * `localhost`/`127.0.0.1`. Aprendo la dashboard dall'IP della LAN
 * (`http://192.168.0.101:3000`) la funzione non esiste e la chiamata diretta
 * lancia `TypeError: crypto.randomUUID is not a function`, che interrompe
 * l'effetto in corso (toast, log RAW, coda comandi) e lascia la UI muta.
 *
 * `crypto.getRandomValues()` invece è esposto anche in HTTP: è il fallback
 * reale e usa la stessa entropia del browser. `Math.random()` resta solo per
 * gli ambienti senza Web Crypto (test, WebView molto vecchie): questi id non
 * sono token di sicurezza, servono a distinguere messaggi e componenti.
 */
export function randomId(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122, versione 4 e variante RFC: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
