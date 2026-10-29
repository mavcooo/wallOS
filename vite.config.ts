import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // `loadEnv` senza prefisso: il target del proxy può stare nel `.env` locale
  // senza finire nel bundle client (a differenza delle variabili VITE_*).
  const env = loadEnv(mode, process.cwd(), '');
  const authTarget = env.AUTH_PROXY_TARGET?.trim() || 'http://127.0.0.1:8787';

  // Unica superficie pubblica del bundle. Le variabili `MQTT_*` non sono più
  // esposte: le credenziali del broker si inseriscono a runtime sul pannello e
  // non devono mai finire negli asset statici.
  const publicEnvPrefixes = ['VITE_'];
  const publicEnv = loadEnv(mode, process.cwd(), publicEnvPrefixes);
  const sensitiveName = /(PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIALS?)/i;
  const leaked = Object.keys(publicEnv).filter((key) => sensitiveName.test(key));
  if (leaked.length > 0) {
    throw new Error(
      `Variabili pubbliche con nome sensibile: ${leaked.join(', ')}. ` +
        'Vite le includerebbe nel bundle: rinominale o rimuovile dal .env.',
    );
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // Il kiosk non ha un utente che accetta un prompt: il nuovo service
        // worker prende il controllo e ricarica alla prima occasione utile.
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        manifest: {
          id: '/',
          name: 'wallOS Dashboard',
          short_name: 'wallOS',
          description: 'Pannello domotico locale Kiosk',
          lang: 'it',
          dir: 'ltr',
          start_url: '/',
          scope: '/',
          // Fullscreen toglie anche le barre di sistema dove il browser lo
          // supporta; standalone resta il fallback su iOS e desktop.
          display: 'fullscreen',
          display_override: ['fullscreen', 'standalone'],
          orientation: 'landscape',
          // Nero puro: nessun flash bianco durante il boot su OLED/LCD.
          theme_color: '#000000',
          background_color: '#000000',
          categories: ['utilities', 'lifestyle'],
          icons: [
            {
              src: '/icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icons/maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: '/icons/icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff,woff2}'],
          navigateFallback: '/index.html',
          // Le API del gateway e il broker non devono mai ricevere l'HTML
          // della SPA: un 404/errore JSON deve arrivare intatto al client.
          navigateFallbackDenylist: [/^\/api\//, /^\/mqtt/],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
        },
        // In sviluppo il service worker nasconderebbe gli hot update.
        devOptions: { enabled: false },
      }),
    ],
    // Solo configurazione pubblica: host/porta/path del broker in `VITE_MQTT_*`.
    // Nessun segreto può avere questo prefisso (controllo sopra) e `MQTT_*`
    // resta confinato al processo Node del server.
    envPrefix: publicEnvPrefixes,
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      rollupOptions: {
        output: {
          // Le pagine sono già `React.lazy`; qui separiamo le dipendenze che
          // restano nel bootstrap della shell. Un unico vendor da oltre 900 kB
          // blocca il parse su Raspberry Pi anche quando la pagina è leggera.
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-dom/client'],
            'mqtt-vendor': ['mqtt'],
            'query-vendor': ['@tanstack/react-query'],
            'i18n-vendor': ['i18next', 'react-i18next'],
            'radix-vendor': [
              '@radix-ui/react-dialog',
              '@radix-ui/react-label',
              '@radix-ui/react-slider',
              '@radix-ui/react-slot',
              '@radix-ui/react-switch',
              '@radix-ui/react-tabs',
            ],
            'icons-vendor': ['lucide-react'],
          },
        },
      },
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
