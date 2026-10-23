import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// I componenti usano gli hook react-i18next: l'istanza deve esistere anche nei
// test che non montano <App /> (che la importa dal proprio entry point).
import '@/i18n';

// React Testing Library fa il cleanup automatico solo con i globali di test
// attivi: qui i test importano `afterEach` da vitest, quindi va chiamato a mano.
afterEach(() => {
  cleanup();
});

// jsdom non implementa ResizeObserver: i componenti Radix (Slider) lo usano per
// misurare il thumb. Basta un no-op, le misure non servono nei test.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    configurable: true,
    writable: true,
  });
}
