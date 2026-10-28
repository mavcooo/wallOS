import { act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => vi.fn(),
}));

vi.mock('@/mqtt/MqttProvider', () => ({
  useMqttApi: () => ({
    sendAction: vi.fn(),
    publishRaw: vi.fn(),
    runScenario: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

/** Vedi `OverviewPage.isolation.test.tsx`: conta i render reali dei widget. */
const lightRenders: string[] = [];
const climateRenders: string[] = [];

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

vi.mock('@/components/widgets/ClimateCard', async () => {
  const actual = await vi.importActual<typeof import('@/components/widgets/ClimateCard')>(
    '@/components/widgets/ClimateCard',
  );
  return {
    ClimateCard: (props: ComponentProps<typeof actual.ClimateCard>) => {
      climateRenders.push(props.device.id);
      return <actual.ClimateCard {...props} />;
    },
  };
});

const { RoomsPage } = await import('@/pages/RoomsPage');
const { useAuthStore } = await import('@/store/authStore');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');
import type { Device } from '@/types/device';

/** Stanza affollata: 30 luci nella stessa vista, come un kiosk reale. */
const SCALE = 30;

function scaledTopology() {
  const base = SEED_TOPOLOGY.devices.find((device) => device.id === 'light-living-main');
  if (!base) throw new Error('light-living-main mancante nel seed');
  const devices: Device[] = Array.from({ length: SCALE }, (_, index) => ({
    ...structuredClone(base),
    id: `light-scale-${index}`,
    name: `Luce ${index}`,
    favorite: false,
    topics: {
      ...base.topics,
      state: `${base.topics.state}/scale-${index}`,
    },
  }));
  return { ...SEED_TOPOLOGY, devices };
}

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
  useHomeStore.getState().setRoom('living');
  useAuthStore.setState({
    status: 'authenticated',
    elevated: false,
    user: {
      id: 'u-admin',
      username: 'admin',
      name: 'Amministratore',
      initials: 'AM',
      role: 'admin',
      allowedRooms: null,
      active: true,
      isKioskDevice: false,
      kioskDeviceId: null,
      lastAccess: null,
      pinLength: 4,
    },
  });
  lightRenders.length = 0;
  climateRenders.length = 0;
});

describe('RoomsPage · isolamento dei re-render', () => {
  it('la telemetria di un device di un’altra stanza non ridisegna la vista', () => {
    renderWithTopology(<RoomsPage />, { topology: SEED_TOPOLOGY });
    lightRenders.length = 0;
    climateRenders.length = 0;

    // Sensore fumo in cucina: la stanza attiva è il soggiorno, quindi non ha
    // card né contatori montati. Solo un re-render della pagina lo toccherebbe.
    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('sensor-kitchen-smoke', { kind: 'sensor', state: { value: false } });
    });

    expect(lightRenders).toEqual([]);
    expect(climateRenders).toEqual([]);
  });

  it('un payload in stanza ridisegna solo la card del device aggiornato', () => {
    renderWithTopology(<RoomsPage />, { topology: SEED_TOPOLOGY });
    lightRenders.length = 0;
    climateRenders.length = 0;

    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('light-living-main', { kind: 'light', state: { brightness: 37 } });
    });

    expect(lightRenders).toEqual(['light-living-main']);
    // Termostato e luce ambiente appartengono alla stessa stanza ma a righe
    // diverse dello store: nessun render.
    expect(climateRenders).toEqual([]);
  });

  it('una temperatura del termostato non tocca le luci della stanza', () => {
    renderWithTopology(<RoomsPage />, { topology: SEED_TOPOLOGY });
    lightRenders.length = 0;
    climateRenders.length = 0;

    act(() => {
      useHomeStore
        .getState()
        .applyDecoded('climate-living', { kind: 'climate', state: { currentTemp: 22.4 } });
    });

    expect(climateRenders).toEqual(['climate-living']);
    expect(lightRenders).toEqual([]);
  });

  it('con 30 luci in stanza i render restano lineari nel numero di device', () => {
    renderWithTopology(<RoomsPage />, { topology: scaledTopology() });
    lightRenders.length = 0;

    // 10 payload consecutivi sulla stessa luce: solo la sua card committa.
    for (let tick = 0; tick < 10; tick += 1) {
      act(() => {
        useHomeStore
          .getState()
          .applyDecoded('light-scale-7', { kind: 'light', state: { brightness: 20 + tick } });
      });
    }
    expect(lightRenders).toHaveLength(10);
    expect(new Set(lightRenders)).toEqual(new Set(['light-scale-7']));

    // Un payload per ciascuna delle 30 luci: un render per device, mai a
    // cascata (30 × 30 sarebbe il comportamento pre-refactor).
    lightRenders.length = 0;
    act(() => {
      for (let index = 0; index < SCALE; index += 1) {
        useHomeStore
          .getState()
          .applyDecoded(`light-scale-${index}`, { kind: 'light', state: { brightness: 30 } });
      }
    });
    expect(lightRenders).toHaveLength(SCALE);
    expect(new Set(lightRenders).size).toBe(SCALE);
  });
});
