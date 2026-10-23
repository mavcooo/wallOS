import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Stesso alias `@` del bundle: i test importano i moduli con i percorsi
// dell'app. La config Vite è una funzione (proxy/auth): qui serve solo il
// transform JSX, quindi non viene riusata.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // jsdom: `window.localStorage` per il persist di zustand, i timer usati da
    // coda/toast e, all'occorrenza, il DOM per i test dei componenti React.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // matcher di jest-dom + cleanup automatico di React Testing Library
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Solo codice applicativo: test, fixture, dizionari e bootstrap esclusi.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/i18n/locales/**',
        'src/types/**',
        'src/main.tsx',
      ],
      thresholds: {
        // Il contratto IoT: parsing/normalizzazione e encoding dei comandi.
        // Una regressione qui corrompe lo store e i widget, quindi la soglia
        // è più alta del resto del frontend.
        'src/mqtt/adapters/**': {
          statements: 95,
          // I rami sono quasi tutti guardie su campi opzionali dei firmware:
          // 80% è il pavimento realistico, statements e righe restano alti.
          branches: 80,
          functions: 100,
          lines: 95,
        },
      },
    },
  },
});
