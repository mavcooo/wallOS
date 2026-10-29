import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSecuritySync } from '@/hooks/useSecuritySync';
import type { SecuritySnapshot } from '@/lib/securityApi';
import { useAuthStore } from '@/store/authStore';
import type { SessionUser } from '@/types/user';
import { useSecurityStore } from '@/store/securityStore';

const api = vi.hoisted(() => ({ state: vi.fn() }));

vi.mock('@/lib/securityApi', () => ({ securityApi: api }));

const USER: SessionUser = {
  id: 'user-test',
  username: 'test',
  name: 'Test Kiosk',
  initials: 'TK',
  role: 'admin',
  allowedRooms: null,
  active: true,
  isKioskDevice: false,
  kioskDeviceId: null,
  lastAccess: null,
  pinLength: 4,
};

function snapshotWithAlarm(): SecuritySnapshot {
  return {
    state: {
      status: 'TRIGGERED',
      armedBy: null,
      armedAt: null,
      disarmedBy: null,
      disarmedAt: null,
      updatedAt: new Date().toISOString(),
    },
    zones: [],
    activeEvents: [
      {
        id: 'evt-1',
        deviceId: 'sensor-kitchen-smoke',
        deviceName: 'Sensore fumo',
        roomId: 'kitchen',
        roomName: 'Cucina',
        zoneId: 'emergency',
        eventType: 'smoke',
        severity: 'critical',
        payload: null,
        triggeredAt: new Date().toISOString(),
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        notes: null,
      },
    ],
    openSensors: [],
  };
}

function Probe() {
  useSecuritySync();
  return null;
}

function renderProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.state.mockReset();
  useSecurityStore.getState().reset();
  useAuthStore.setState({ status: 'authenticated', user: USER, elevated: false });
});

describe('useSecuritySync', () => {
  it('al boot legge /api/security/state e pubblica gli allarmi pendenti nello store', async () => {
    api.state.mockResolvedValue(snapshotWithAlarm());

    renderProbe();

    await waitFor(() => {
      expect(useSecurityStore.getState().snapshot?.activeEvents).toHaveLength(1);
    });
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(useSecurityStore.getState().snapshot?.state.status).toBe('TRIGGERED');
  });

  it('senza sessione non interroga il server e non mostra allarmi', async () => {
    useAuthStore.setState({ status: 'anonymous', user: null });

    renderProbe();
    await Promise.resolve();

    expect(api.state).not.toHaveBeenCalled();
    expect(useSecurityStore.getState().snapshot).toBeNull();
  });

  it('al logout svuota lo store', async () => {
    api.state.mockResolvedValue(snapshotWithAlarm());
    renderProbe();
    await waitFor(() => {
      expect(useSecurityStore.getState().snapshot).not.toBeNull();
    });

    useAuthStore.setState({ status: 'anonymous', user: null });

    await waitFor(() => {
      expect(useSecurityStore.getState().snapshot).toBeNull();
    });
  });
});
