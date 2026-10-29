/// <reference types="vite/client" />

/**
 * Variabili pubbliche lette a startup come default del broker (vedi `.env.example`).
 *
 * Solo prefisso `VITE_`: host, porta, path e base topic non sono segreti. Le
 * credenziali del broker NON passano da qui — si inseriscono una volta sul
 * pannello (Impostazioni → broker) e vengono persistite in locale.
 */
interface ImportMetaEnv {
  readonly VITE_MQTT_HOST?: string;
  readonly VITE_MQTT_PORT?: string;
  readonly VITE_MQTT_PROTOCOL?: string;
  readonly VITE_MQTT_PATH?: string;
  readonly VITE_MQTT_BASE_TOPIC?: string;
  readonly VITE_MQTT_DISCOVERY_PREFIXES?: string;
  /** Base delle API auth (default `/api`, proxata dal dev server). */
  readonly VITE_AUTH_API_BASE?: string;
  /** Identificativo del tablet a parete usato da /api/auth/kiosk-session. */
  readonly VITE_KIOSK_DEVICE_ID?: string;
}
