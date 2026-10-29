import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CriticalAlertOverlay } from '@/components/ui/CriticalAlertOverlay';
import type { SecurityEventRecord } from '@/lib/securityApi';
import { useSecurityStore } from '@/store/securityStore';
import { useToastStore } from '@/store/toastStore';

const audio = vi.hoisted(() => ({
  playAlarm: vi.fn(),
  stopAlarm: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock('@/utils/audioAlert', () => ({
  audioAlert: audio,
  bindAudioUnlockOnFirstGesture: vi.fn(),
}));

const api = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@/lib/securityApi', () => ({ securityApi: api }));

/**
 * Il PIN è testato in `PinProtectionDialog.test.tsx`: qui interessa il
 * contratto dell'overlay, quindi il guard conferma subito come farebbe
 * l'utente dopo aver digitato il PIN corretto.
 */
vi.mock('@/components/kiosk/PinProvider', () => ({
  usePinGuard: () => (request: { onConfirm: () => void }) => request.onConfirm(),
}));

function securityEvent(overrides: Partial<SecurityEventRecord> = {}): SecurityEventRecord {
  return {
    id: 'evt-1',
    deviceId: 'sensor-kitchen-smoke',
    deviceName: 'Sensore fumo',
    roomId: 'kitchen',
    roomName: 'Cucina',
    zoneId: 'emergency',
    eventType: 'smoke',
    severity: 'critical',
    payload: null,
    triggeredAt: new Date('2026-10-29T08:15:00Z').toISOString(),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    notes: null,
    ...overrides,
  };
}

function setActiveEvents(events: SecurityEventRecord[]): void {
  act(() => {
    useSecurityStore.getState().setSnapshot({
      state: {
        status: events.length > 0 ? 'TRIGGERED' : 'DISARMED',
        armedBy: null,
        armedAt: null,
        disarmedBy: null,
        disarmedAt: null,
        updatedAt: new Date().toISOString(),
      },
      zones: [],
      activeEvents: events,
      openSensors: [],
    });
  });
}

function renderOverlay() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CriticalAlertOverlay />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSecurityStore.getState().reset();
  useToastStore.setState({ toasts: [], history: [], alarmSilenced: false });
  audio.playAlarm.mockClear();
  audio.stopAlarm.mockClear();
  api.acknowledge.mockReset();
  api.resolve.mockReset();
  api.acknowledge.mockResolvedValue(securityEvent({ acknowledgedAt: new Date().toISOString() }));
  api.resolve.mockResolvedValue(securityEvent({ resolvedAt: new Date().toISOString() }));
});

describe('CriticalAlertOverlay', () => {
  it('mostra gli allarmi persistiti e avvia la sirena', () => {
    setActiveEvents([
      securityEvent(),
      securityEvent({ id: 'evt-2', deviceId: 'sensor-bath', deviceName: 'Sensore bagno', eventType: 'flood' }),
    ]);

    renderOverlay();

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fumo rilevato' })).toBeInTheDocument();
    expect(screen.getByText('Sensore fumo · Cucina')).toBeInTheDocument();
    expect(screen.getByText('1 altro allarme attivo')).toBeInTheDocument();
    expect(audio.playAlarm).toHaveBeenCalledWith('siren');
  });

  it('non mostra nulla senza eventi aperti (anche dopo un reload)', () => {
    renderOverlay();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(audio.playAlarm).not.toHaveBeenCalled();
  });

  it('«Tacita segnale sonoro» ferma solo l’audio locale e non chiude l’allarme', () => {
    setActiveEvents([securityEvent()]);
    renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: 'Tacita segnale sonoro' }));

    expect(audio.stopAlarm).toHaveBeenCalled();
    // Nessuna chiamata al server: l'evento resta aperto su PostgreSQL.
    expect(api.acknowledge).not.toHaveBeenCalled();
    expect(api.resolve).not.toHaveBeenCalled();
    expect(useSecurityStore.getState().snapshot?.activeEvents).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Fumo rilevato' })).toBeInTheDocument();
  });

  it('«Conferma allarme (ACK)» passa dal PIN e registra l’acknowledgment', async () => {
    setActiveEvents([securityEvent()]);
    renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: 'Conferma allarme (ACK)' }));

    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith('evt-1'));

    // Lo snapshot successivo porta `acknowledgedAt`: l'evento resta a schermo.
    setActiveEvents([securityEvent({ acknowledgedAt: new Date().toISOString() })]);
    const ackButton = screen.getByRole('button', { name: 'Allarme confermato' });
    expect(ackButton).toBeDisabled();
    expect(screen.getByText('Allarme preso in carico')).toBeInTheDocument();
    expect(audio.stopAlarm).toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('mostra ancora gli avvisi di sistema (broker/database) senza allarmi di sicurezza', () => {
    const id = useToastStore.getState().addCritical({
      title: 'Broker MQTT offline',
      description: 'Nessuna connessione da oltre un minuto.',
      metadata: { type: 'connection', source: 'broker' },
    });
    renderOverlay();

    expect(screen.getByRole('heading', { name: 'Broker MQTT offline' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tacita segnale sonoro' }));
    expect(useToastStore.getState().alarmSilenced).toBe(true);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Riconosci e chiudi' }));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().history[0]?.id).toBe(id);
  });

  it('un allarme di sicurezza ha la precedenza su un avviso di sistema', () => {
    useToastStore.getState().addCritical({ title: 'Broker MQTT offline' });
    setActiveEvents([securityEvent()]);

    renderOverlay();

    expect(screen.getByRole('heading', { name: 'Fumo rilevato' })).toBeInTheDocument();
    expect(screen.queryByText('Broker MQTT offline')).not.toBeInTheDocument();
  });

  it('«Segna risolto» chiude l’evento tramite API', async () => {
    setActiveEvents([securityEvent({ acknowledgedAt: new Date().toISOString() })]);
    renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: 'Segna risolto' }));

    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith('evt-1'));

    // Il server ha chiuso l'evento: lo snapshot successivo è vuoto.
    setActiveEvents([]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
