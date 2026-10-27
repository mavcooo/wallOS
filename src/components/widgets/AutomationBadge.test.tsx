import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_FRESH_MS,
  AutomationBadge,
  automationActivityFor,
} from '@/components/widgets/AutomationBadge';
import { automationActivityQueryKey } from '@/hooks/useAutomations';
import i18n from '@/i18n';
import { createTestQueryClient } from '@/test/query';
import type { DeviceAutomationActivity } from '@/types/automations';

function activity(overrides: Partial<DeviceAutomationActivity> = {}): DeviceAutomationActivity {
  return {
    deviceId: 'light-living-main',
    automationId: 'automation-1',
    automationName: 'Luce corridoio di notte',
    triggerSource: 'mqtt:stat/sensore_soggiorno/MOTION',
    scenarioId: null,
    scenarioLabel: null,
    topic: 'zigbee2mqtt/living/main/set',
    payload: '{"state":"ON"}',
    at: Date.now() - 60_000,
    ...overrides,
  };
}

function renderBadge(entries: DeviceAutomationActivity[], deviceId = 'light-living-main') {
  const client = createTestQueryClient();
  client.setQueryData(automationActivityQueryKey, entries);
  render(
    <QueryClientProvider client={client}>
      <AutomationBadge deviceId={deviceId} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('it');
});

describe('automationActivityFor', () => {
  it('tiene solo i comandi recenti del dispositivo richiesto', () => {
    const fresh = activity();
    const stale = activity({ deviceId: 'light-bath', at: Date.now() - ACTIVITY_FRESH_MS - 1 });

    expect(automationActivityFor([fresh, stale], 'light-living-main')).toEqual(fresh);
    // Un comando di due ore fa non spiega più lo stato attuale.
    expect(automationActivityFor([stale], 'light-bath')).toBeNull();
    expect(automationActivityFor([fresh], 'light-kitchen-strip')).toBeNull();
    expect(automationActivityFor(undefined, 'light-living-main')).toBeNull();
  });
});

describe('AutomationBadge', () => {
  it('dichiara quale automazione ha comandato il dispositivo', () => {
    renderBadge([activity()]);

    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Luce corridoio di notte');
    expect(badge).toHaveAttribute('data-automation', 'automation-1');
    expect(badge.getAttribute('aria-label')).toBe(
      'Comandato dall’automazione «Luce corridoio di notte» · 1m fa',
    );
  });

  it('nomina anche lo scenario quando il comando viene da lì', () => {
    renderBadge([activity({ scenarioId: 'goodnight', scenarioLabel: 'Buonanotte' })]);

    expect(screen.getByRole('status').getAttribute('title')).toMatch(
      /automazione «Luce corridoio di notte» con lo scenario «Buonanotte»/,
    );
  });

  it('non mostra nulla senza attività o con un comando troppo vecchio', () => {
    renderBadge([]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
