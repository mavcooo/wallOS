import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClimateScheduleModal } from '@/components/widgets/ClimateScheduleModal';
import { climateQueryKey } from '@/hooks/useClimateSchedule';
import i18n from '@/i18n';
import { createTestQueryClient } from '@/test/query';
import type { ClimateScheduleResponse, DayOfWeek } from '@/types/climate';

const DEVICE = 'climate-living';
const today = new Date().getDay() as DayOfWeek;

function scheduleResponse(overrides: Partial<ClimateScheduleResponse> = {}): ClimateScheduleResponse {
  return {
    deviceId: DEVICE,
    deviceName: 'Termostato soggiorno',
    schedules: [
      {
        id: 'band-1',
        dayOfWeek: today,
        startTime: '06:00',
        endTime: '08:00',
        targetTemp: 20.5,
        preset: 'comfort',
        isActive: true,
      },
    ],
    runtime: { override: null, vacation: null, lastSent: null },
    activeSchedule: null,
    nextChangeAt: null,
    ...overrides,
  };
}

function renderModal(data: ClimateScheduleResponse = scheduleResponse()) {
  const client = createTestQueryClient();
  client.setQueryData(climateQueryKey(DEVICE), data);
  const onOpenChange = vi.fn();

  render(
    <QueryClientProvider client={client}>
      <ClimateScheduleModal
        deviceId={DEVICE}
        deviceName="Termostato soggiorno"
        open
        onOpenChange={onOpenChange}
        minTemp={5}
        maxTemp={30}
      />
    </QueryClientProvider>,
  );

  return { client, onOpenChange };
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('it');
});

describe('ClimateScheduleModal', () => {
  it('mostra il programma del giorno corrente e la timeline', () => {
    renderModal();

    expect(screen.getByText('Programma settimanale')).toBeInTheDocument();
    expect(screen.getByText('06:00–08:00')).toBeInTheDocument();
    expect(screen.getByText('20,5°')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Aggiungi fascia/i })).toBeEnabled();
  });

  it('aggiunge una fascia, ne cambia il preset e salva tutta la settimana', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(scheduleResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderModal();

    await user.click(screen.getByRole('button', { name: /Aggiungi fascia/i }));

    // Il primo buco utile è 00:00–01:00: la nuova fascia non si sovrappone.
    expect(screen.getByText('00:00–01:00')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Eco' }));
    await user.click(screen.getByRole('button', { name: /Salva programma/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(String(url)).toContain(`/api/climate/${DEVICE}/schedules`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as {
      schedules: { startTime: string; endTime: string; preset: string }[];
    };
    expect(body.schedules).toHaveLength(2);
    expect(body.schedules).toContainEqual(
      expect.objectContaining({ startTime: '00:00', endTime: '01:00', preset: 'eco' }),
    );
    expect(body.schedules).toContainEqual(
      expect.objectContaining({ startTime: '06:00', endTime: '08:00', preset: 'comfort' }),
    );

    await vi.unstubAllGlobals();
  });

  it('non permette di aggiungere fasce quando la giornata è piena', () => {
    renderModal(
      scheduleResponse({
        schedules: [
          {
            id: 'band-full',
            dayOfWeek: today,
            startTime: '00:00',
            endTime: '24:00',
            targetTemp: 20,
            preset: 'comfort',
            isActive: true,
          },
        ],
      }),
    );

    expect(screen.getByRole('button', { name: /Aggiungi fascia/i })).toBeDisabled();
    expect(screen.getByText('00:00–24:00')).toBeInTheDocument();
  });
});
