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
  },
});
