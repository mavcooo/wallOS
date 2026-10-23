import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { EnergyPage } = await import('@/pages/EnergyPage');
const { default: i18n } = await import('@/i18n');
const { useHomeStore } = await import('@/store/homeStore');
const { SEED_TOPOLOGY } = await import('@/test/fixtures');

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  useHomeStore.getState().hydrateTopology(SEED_TOPOLOGY);
});

afterEach(async () => {
  await i18n.changeLanguage('it');
});

describe('EnergyPage · inglese', () => {
  it('traduce metriche, sezioni e prese', () => {
    render(<EnergyPage />);

    expect(screen.getByText('Instantaneous load')).toBeInTheDocument();
    expect(screen.getByText('Daily consumption')).toBeInTheDocument();
    expect(screen.getByText('Real-time telemetry')).toBeInTheDocument();
    expect(screen.getByText('Load balance')).toBeInTheDocument();
    expect(screen.getByText('Smart sockets')).toBeInTheDocument();
  });
});
