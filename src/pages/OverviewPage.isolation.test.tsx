import { act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({
    sendAction: vi.fn(),
    publishRaw: vi.fn(),
    runScenario: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

/**
 * Contatore dei render dei widget. Il wrapper non è memoizzato: viene
 * richiamato solo quando la card che lo contiene (o la pagina, se si
 * ridisegnasse) committa un aggiornamento.
 */
const lightRenders: string[] = [];
const powerRenders: string[] = [];

vi.mock('@/components/widgets/LightCard', async () => {
  const actual = await vi.importActual<typeof import('@/components/widgets/LightCard')>(
    '@/components/widgets/LightCard',
  );
  return {
    LightCard: (props: ComponentProps<typeof actual.LightCard>) => {
      lightRenders.push(props.device.id);
      return <actual.LightCard {...props} />;
    },
  };
});

vi.mock('@/components/widgets/PowerCard', async () => {
  const actual = await vi.importActual<typeof import('@/components/widgets/PowerCard')>(
    '@/components/widgets/PowerCard',
  );
  return {
    PowerCard: (props: ComponentProps<typeof actual.PowerCard>) => {
      powerRenders.push(props.device.id);
      return <actual.PowerCard {...props} />;
    },
  };
});

const { OverviewPage } = await import('@/pages/OverviewPage');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
  lightRenders.length = 0;
  powerRenders.length = 0;
});

describe('OverviewPage · isolamento dei re-render', () => {
  it('la telemetria di un device senza card non ridisegna alcun widget', () => {
    renderWithTopology(<OverviewPage />, { topology: SEED_TOPOLOGY });
    lightRenders.length = 0;
    powerRenders.length = 0;

    // CO2 del ripostiglio: non è nei preferiti e nessun sottotree della
    // pagina la osserva. L'unico render possibile sarebbe della pagina.
    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('sensor-study-co2', { kind: 'sensor', state: { value: 712 } });
    });

    expect(lightRenders).toEqual([]);
    expect(powerRenders).toEqual([]);
  });

  it('un payload su un preferito ridisegna solo il widget di quel device', () => {
    renderWithTopology(<OverviewPage />, { topology: SEED_TOPOLOGY });
    lightRenders.length = 0;
    powerRenders.length = 0;

    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('power-study-desk', { kind: 'power', state: { on: true, watts: 940 } });
    });

    expect(powerRenders).toEqual(['power-study-desk']);
    // La luce del soggiorno è l'altro preferito a schermo: non va toccata.
    expect(lightRenders).toEqual([]);
  });

  it('una luce nei preferiti non ridisegna le prese', () => {
    renderWithTopology(<OverviewPage />, { topology: SEED_TOPOLOGY });
    lightRenders.length = 0;
    powerRenders.length = 0;

    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('light-living-main', { kind: 'light', state: { brightness: 55 } });
    });

    expect(lightRenders).toEqual(['light-living-main']);
    expect(powerRenders).toEqual([]);
  });
});
