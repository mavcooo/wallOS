/// <reference types="vite/client" />

/**
 * Variabili lette a startup come default del broker (vedi `.env.example`).
 * Vite le espone al browser perché `MQTT_` è in `envPrefix` (`vite.config.ts`).
 */
interface ImportMetaEnv {
  readonly MQTT_HOST?: string;
  readonly MQTT_PORT?: string;
  readonly MQTT_PROTOCOL?: string;
  readonly MQTT_PATH?: string;
  readonly MQTT_BASE_TOPIC?: string;
  readonly MQTT_USERNAME?: string;
  readonly MQTT_PASSWORD?: string;
}
