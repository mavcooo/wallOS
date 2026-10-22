import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // `loadEnv` senza prefisso: il target del proxy può stare nel `.env` locale
  // senza finire nel bundle client (a differenza delle variabili VITE_*).
  const env = loadEnv(mode, process.cwd(), '');
  const authTarget = env.AUTH_PROXY_TARGET?.trim() || 'http://127.0.0.1:8787';

  return {
    plugins: [react(), tailwindcss()],
    // `MQTT_*` (vedi .env.example) deve arrivare all'app: Vite espone di default
    // solo le variabili con prefisso `VITE_`.
    envPrefix: ['VITE_', 'MQTT_'],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      // Stessa origine del pannello: i cookie HttpOnly restano SameSite=Strict
      // e non serve esporre il servizio auth con CORS sulle singole LAN.
      proxy: { '/api': { target: authTarget, changeOrigin: false } },
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      proxy: { '/api': { target: authTarget, changeOrigin: false } },
    },
  };
});
