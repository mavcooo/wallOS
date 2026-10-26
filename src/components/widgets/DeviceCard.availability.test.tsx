import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mqttApi = vi.hoisted(() => ({
  sendAction: vi.fn(),
  publishRaw: vi.fn(),
  runScenario: vi.fn(),
  reconnect: vi.fn(),
}));

vi.mock('@/mqtt/MqttProvider', () => ({ useMqttApi: () => mqttApi }));
vi.mock('@/components/kiosk/PinProvider', () => ({ usePinGuard: () => vi.fn() }));

const { DeviceCard } = await import('@/components/widgets/DeviceCard');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');
const { renderWithTopology } = await import('@/test/query');

const LIGHT_ID = 'light-living-main';

beforeEach(() => {
  localStorage.clear();
  useHomeStore.setState({ deviceStates: {} });
  // Questi casi descrivono il pannello già idratato: il Safe Boot è concluso,
  // quindi l'unico motivo di blocco resta la disponibilità del device.
  useHomeStore.getState().finishHydration();
  mqttApi.sendAction.mockClear();
});

function renderLight() {
  return renderWithTopology(<DeviceCard deviceId={LIGHT_ID} />, {
    topology: SEED_TOPOLOGY,
  });
}

describe('DeviceCard · disponibilità', () => {
  it('offline: badge, controlli disabilitati e nessun comando MQTT', async () => {
    const user = userEvent.setup();
    renderLight();

    const toggle = screen.getByRole('switch');
    expect(toggle).toBeEnabled();

    act(() => {
      useHomeStore.getState().setAvailability(LIGHT_ID, 'offline');
    });

    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Offline');
    expect(toggle).toBeDisabled();
    // L'intero sottoalbero è inerte: slider, presets e preferiti compresi.
    expect(toggle.closest('[inert]')).not.toBeNull();

    // Il tap non arriva al broker: la card è inerte oltre che disabilitata.
    await user.click(toggle);
    expect(mqttApi.sendAction).not.toHaveBeenCalled();
  });

  it('il ritorno online riabilita la card senza rimontarla', () => {
    renderLight();

    act(() => {
      useHomeStore.getState().setAvailability(LIGHT_ID, 'stale');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Senza dati');
    expect(screen.getByRole('switch')).toBeDisabled();

    act(() => {
      useHomeStore.getState().setAvailability(LIGHT_ID, 'online');
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeEnabled();
    expect(screen.getByRole('switch').closest('[inert]')).toBeNull();
  });

  it('stale: il badge mostra i minuti dall’ultima lettura', () => {
    renderLight();

    act(() => {
      const states = useHomeStore.getState().deviceStates;
      const row = states[LIGHT_ID];
      if (!row) throw new Error('riga realtime mancante');
      useHomeStore.setState({
        deviceStates: {
          ...states,
          [LIGHT_ID]: {
            ...row,
            availability: 'stale',
            isAvailable: false,
            lastSeen: Date.now() - 12 * 60_000,
          },
        },
      });
    });

    expect(screen.getByRole('status').getAttribute('title')).toContain('12');
  });
});
