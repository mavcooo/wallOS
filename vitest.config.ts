import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

// Stessa configurazione di Vite (alias `@` compreso): così i test importano i
// moduli dell'app con gli stessi percorsi del bundle.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // jsdom: `window.localStorage` per il persist di zustand, i timer usati da
      // coda/toast e, all'occorrenza, il DOM per i test dei componenti React.
      environment: 'jsdom',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      // matcher di jest-dom + cleanup automatico di React Testing Library
      setupFiles: ['src/test/setup.ts'],
    },
  }),
);
