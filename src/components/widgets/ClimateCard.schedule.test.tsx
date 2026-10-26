import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClimateCard } from '@/components/widgets/ClimateCard';
import { climateQueryKey } from '@/hooks/useClimateSchedule';
import i18n from '@/i18n';
import { createTestQueryClient } from '@/test/query';
import { deviceOf } from '@/test/fixtures';
import type { ClimateRuntimeState, ClimateScheduleResponse, DayOfWeek } from '@/types/climate';

const DEVICE = 'climate-living';
const today = new Date().getDay() as DayOfWeek;

function scheduleData(
  runtime: ClimateRuntimeState = { override: null, vacation: null, lastSent: null },
): ClimateScheduleResponse {
  return {
    deviceId: DEVICE,
    deviceName: 'Clima soggiorno',
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
    runtime,
    activeSchedule: null,
    nextChangeAt: Date.now() + 3 * 60 * 60_000,
  };
}

/** `fetch` finto: il pannello non deve mai uscire verso la rete nei test. */
function stubFetch(data: ClimateScheduleResponse) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderCard(data: ClimateScheduleResponse, onAction = vi.fn()) {
  const client = createTestQueryClient();
  client.setQueryData(climateQueryKey(DEVICE), data);

  render(
    <QueryClientProvider client={client}>
      <ClimateCard
        device={deviceOf(DEVICE, 'climate')}
        roomName="Soggiorno"
        onAction={onAction}
      />
    </QueryClientProvider>,
  );

  return { client, onAction };
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('it');
  vi.unstubAllGlobals();
});

describe('ClimateCard · cronotermostato', () => {
  it('dopo una modifica manuale chiede per quanto mantenere il setpoint', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(scheduleData());
    const { onAction } = renderCard(scheduleData());

    await user.click(screen.getByRole('button', { name: 'Aumenta setpoint' }));

    // Il comando parte subito verso il broker…
    expect(onAction).toHaveBeenCalledWith({ type: 'targetTemp', targetTemp: 22 });
    // …e l'override provvisorio viene registrato già con il tocco, così il job
    // al minuto non può riallineare il setpoint mentre l'utente sceglie.
    expect(await screen.findByRole('heading', { name: /Mantieni/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 ora/ })).toBeInTheDocument();

    const overrideBodies = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).includes(`/api/climate/${DEVICE}/override`))
        .map(([, init]) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);

    await waitFor(() =>
      expect(overrideBodies()).toContainEqual(
        expect.objectContaining({ targetTemp: 22, until: 'next_schedule' }),
      ),
    );

    await user.click(screen.getByRole('button', { name: /2 ora/ }));

    await waitFor(() =>
      expect(overrideBodies()).toContainEqual(
        expect.objectContaining({ targetTemp: 22, durationMinutes: 120 }),
      ),
    );
  });

  it('senza programma configurato non chiede nulla', async () => {
    const user = userEvent.setup();
    const data: ClimateScheduleResponse = {
      ...scheduleData(),
      schedules: [],
      nextChangeAt: null,
    };
    const { onAction } = renderCard(data);

    await user.click(screen.getByRole('button', { name: 'Aumenta setpoint' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: /Mantieni/i })).not.toBeInTheDocument();
  });

  it('mostra l’override attivo e lo annulla con un tocco', async () => {
    const user = userEvent.setup();
    const until = new Date();
    until.setHours(18, 30, 0, 0);
    const withOverride = scheduleData({
      override: { targetTemp: 21.5, preset: 'comfort', until: until.getTime(), permanent: false },
      vacation: null,
      lastSent: null,
    });

    const fetchMock = stubFetch(scheduleData());
    renderCard(withOverride);

    expect(screen.getByText(/Override fino alle 18:30/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Annulla override' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(`/api/climate/${DEVICE}/override`);
    expect(init.method).toBe('DELETE');
    await waitFor(() =>
      expect(screen.queryByText(/Override fino alle/)).not.toBeInTheDocument(),
    );
  });

  it('la vacanza ha un badge dedicato e si termina dalla card', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(scheduleData());
    renderCard(
      scheduleData({
        override: null,
        vacation: { until: Date.now() + 86_400_000, permanent: false },
        lastSent: null,
      }),
    );

    expect(screen.getByText(/Vacanza fino al/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Termina vacanza' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(`/api/climate/${DEVICE}/vacation`);
    expect(JSON.parse(String(init.body))).toMatchObject({ active: false });
  });
});
