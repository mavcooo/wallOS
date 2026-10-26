import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClimateCard } from '@/components/widgets/ClimateCard';
import { climateQueryKey } from '@/hooks/useClimateSchedule';
import i18n from '@/i18n';
import { createTestQueryClient } from '@/test/query';
import { deviceOf } from '@/test/fixtures';
import type { ClimateScheduleResponse } from '@/types/climate';

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  await i18n.changeLanguage('it');
});

describe('ClimateCard · inglese', () => {
  it('traduce modalità, stato, umidità e controlli', () => {
    // La card legge il programma del cronotermostato: cache già popolata, così
    // il test resta senza rete e la lingua inglese copre anche le nuove chiavi.
    const client = createTestQueryClient();
    const schedule: ClimateScheduleResponse = {
      deviceId: 'climate-living',
      deviceName: 'Clima soggiorno',
      schedules: [],
      runtime: { override: null, vacation: null, lastSent: null },
      activeSchedule: null,
      nextChangeAt: null,
    };
    client.setQueryData(climateQueryKey('climate-living'), schedule);

    render(
      <QueryClientProvider client={client}>
        <ClimateCard
          device={deviceOf('climate-living', 'climate')}
          roomName="Soggiorno"
          onAction={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/Humidity 47%/)).toBeInTheDocument();
    expect(screen.getByText('Heating')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Heat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raise setpoint' })).toBeInTheDocument();
    expect(screen.getByText('Fan')).toBeInTheDocument();
    expect(screen.getByText('Oscillation')).toBeInTheDocument();
  });
});
