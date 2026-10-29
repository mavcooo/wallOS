import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecuritySystemCard } from '@/components/settings/SecuritySystemCard';
import i18n from '@/i18n';
import type { SecuritySnapshot } from '@/lib/securityApi';
import { useAuthStore } from '@/store/authStore';
import { useSecurityStore } from '@/store/securityStore';
import { createTestQueryClient } from '@/test/query';
import type { SessionUser } from '@/types/user';

const admin: SessionUser = {
  id: 'user-test',
  username: 'admin',
  name: 'Admin',
  initials: 'AD',
  role: 'admin',
  allowedRooms: null,
  active: true,
  isKioskDevice: false,
  kioskDeviceId: null,
  lastAccess: null,
  pinLength: 4,
};

function snapshot(status: SecuritySnapshot['state']['status']): SecuritySnapshot {
  return {
    state: {
      status,
      armedBy: null,
      armedAt: status === 'DISARMED' ? null : '2026-10-29T08:00:00.000Z',
      disarmedBy: null,
      disarmedAt: null,
      updatedAt: '2026-10-29T08:00:00.000Z',
    },
    zones: [
      {
        id: 'emergency',
        name: 'Emergenza 24H',
        kind: 'emergency',
        armHome: true,
        armAway: true,
        sensors: [
          {
            deviceId: 'sensor-kitchen-smoke',
            name: 'Sensore fumo',
            roomId: 'kitchen',
            roomName: 'Cucina',
            eventType: 'smoke',
            stateTopic: 'zigbee2mqtt/kitchen/smoke',
          },
        ],
      },
      {
        id: 'perimeter',
        name: 'Perimetrale',
        kind: 'perimeter',
        armHome: false,
        armAway: true,
        sensors: [],
      },
      {
        id: 'interior',
        name: 'Interna',
        kind: 'interior',
        armHome: true,
        armAway: true,
        sensors: [
          {
            deviceId: 'sensor-hall-motion',
            name: 'PIR corridoio',
            roomId: 'living',
            roomName: 'Soggiorno',
            eventType: 'motion',
            stateTopic: 'zigbee2mqtt/living/motion',
          },
        ],
      },
    ],
    activeEvents: [],
    openSensors: [],
  };
}

/** Il PIN è testato a parte: qui il guard conferma subito. */
vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => (request: { onConfirm: () => void }) => request.onConfirm(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderCard() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SecuritySystemCard />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('it');
  useSecurityStore.getState().reset();
  useAuthStore.setState({ status: 'authenticated', user: admin, elevated: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SecuritySystemCard', () => {
  it('mostra lo stato e arma l’impianto in modalità fuori', async () => {
    useSecurityStore.getState().setSnapshot(snapshot('DISARMED'));

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain('/api/security/arm');
      expect(init?.body).toContain('ARMED_AWAY');
      return jsonResponse(snapshot('ARMED_AWAY'));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCard();
    expect(screen.getByTestId('security-status')).toHaveTextContent('Disinserito');
    expect(screen.getByText('PIR corridoio · Soggiorno')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Inserisci \(fuori\)/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('security-status')).toHaveTextContent('Inserito · fuori'),
    );
  });

  it('salva la policy della zona e sposta un sensore', async () => {
    useSecurityStore.getState().setSnapshot(snapshot('DISARMED'));

    const calls: { url: string; body: string }[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const zones = snapshot('DISARMED').zones;
      return jsonResponse({
        zones:
          body['zoneId'] !== undefined
            ? zones
            : zones.map((zone) =>
                zone.id === 'interior' ? { ...zone, armHome: false } : zone,
              ),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCard();

    // Toggle "Casa" della zona interna: è l'ultimo switch della lista.
    const homeSwitches = screen.getAllByRole('switch', { name: /Casa/ });
    fireEvent.click(homeSwitches[homeSwitches.length - 1] as HTMLElement);

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes('/api/security/zones/interior'))).toBe(true),
    );
    expect(calls[0]?.body).toContain('armHome');

    // Sposta il PIR dalla zona interna al perimetro.
    fireEvent.change(screen.getByRole('combobox', { name: 'Sposta PIR corridoio in un\'altra zona' }), {
      target: { value: 'perimeter' },
    });

    await waitFor(() =>
      expect(
        calls.some((call) => call.url.includes('/api/security/sensors/sensor-hall-motion')),
      ).toBe(true),
    );
  });

  it('elenca i sensori aperti che bloccano l’armamento', () => {
    useSecurityStore.getState().setSnapshot({
      ...snapshot('DISARMED'),
      openSensors: [
        {
          deviceId: 'sensor-balcony-door',
          name: 'Finestra balcone',
          roomName: 'Soggiorno',
          eventType: 'contact',
          since: '2026-10-29T08:00:00.000Z',
        },
      ],
    });

    renderCard();

    expect(
      screen.getByText(/Sensori non in riposo: l'impianto non si arma/),
    ).toBeInTheDocument();
    expect(screen.getByText('Finestra balcone · Soggiorno')).toBeInTheDocument();
  });
});
