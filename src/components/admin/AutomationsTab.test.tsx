import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutomationsTab } from '@/components/admin/AutomationsTab';
import { automationsQueryKey } from '@/hooks/useAutomations';
import i18n from '@/i18n';
import { createTestQueryClient } from '@/test/query';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import { useToastStore } from '@/store/toastStore';
import type { Automation, AutomationLogEntry } from '@/types/automations';
import type { QueryClient } from '@tanstack/react-query';

const RULE_ID = '11111111-1111-4111-8111-111111111111';

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: RULE_ID,
    name: 'Luce corridoio di notte',
    description: 'Movimento in soggiorno fra le 23:00 e le 06:00',
    isActive: true,
    triggerType: 'mqtt_state',
    triggerConfig: { topic: 'stat/sensore_soggiorno/MOTION', payloadKey: 'occupancy' },
    conditions: [
      { type: 'time_range', start: '23:00', end: '06:00' },
      { type: 'user_present', requireHome: true },
    ],
    conditionGroups: [],
    actions: [{ type: 'mqtt', topic: 'cmnd/light_corridoio/dimmer', payload: '10', delayMs: 0 }],
    lastTriggeredAt: Date.now() - 60_000,
    executionCount: 3,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 60_000,
    lastRun: {
      at: Date.now() - 60_000,
      triggerSource: 'mqtt:stat/sensore_soggiorno/MOTION',
      conditionsMet: true,
      executionTimeMs: 42,
      error: null,
      actions: null,
    },
    invalidReason: null,
    summary: 'Luce corridoio di notte [mqtt_state] stat/sensore_soggiorno/MOTION → true',
    ...overrides,
  };
}

function renderTab(rules: Automation[] = [automation()]): QueryClient {
  const client = createTestQueryClient();
  client.setQueryData(automationsQueryKey, rules);
  client.setQueryData(['topology'], SEED_TOPOLOGY);
  render(
    <QueryClientProvider client={client}>
      <AutomationsTab />
    </QueryClientProvider>,
  );
  return client;
}

function jsonRoute(payload: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

beforeEach(async () => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  await i18n.changeLanguage('it');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AutomationsTab · elenco', () => {
  it('mostra la regola con trigger, conteggi e ultima esecuzione', () => {
    renderTab();

    expect(screen.getByText('Luce corridoio di notte')).toBeInTheDocument();
    expect(screen.getByText('Sensore MQTT')).toBeInTheDocument();
    expect(screen.getByText('Condizioni: 2')).toBeInTheDocument();
    expect(screen.getByText('Azioni: 1')).toBeInTheDocument();
    expect(screen.getByText('Successo · 42 ms')).toBeInTheDocument();
    expect(screen.getByText(/Statistiche no|3 esecuzioni/)).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Attiva o disattiva Luce corridoio di notte' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('mostra quanti gruppi di condizioni sono in OR e quante azioni sono scenari', () => {
    renderTab([
      automation({
        conditionGroups: [
          [{ type: 'user_present', requireHome: true }],
          [{ type: 'device_state', deviceId: 'light-living-main', expectedState: 'ON' }],
        ],
        actions: [
          { type: 'scenario', scenarioId: 'goodnight', delayMs: 0 },
          { type: 'mqtt', topic: 'cmnd/light_corridoio/dimmer', payload: '10', delayMs: 0 },
        ],
      }),
    ]);

    expect(screen.getByText('Condizioni: 4')).toBeInTheDocument();
    expect(screen.getByText('3 gruppi in OR')).toBeInTheDocument();
    expect(screen.getByText('Azioni: 2')).toBeInTheDocument();
    expect(screen.getByText('Scenari: 1')).toBeInTheDocument();
  });

  it('distingue condizioni non soddisfatte e regole non eseguibili', () => {
    renderTab([
      automation({
        id: 'other',
        name: 'Tramonto',
        triggerType: 'sun_event',
        triggerConfig: { event: 'sunset', offsetMinutes: -15 },
        invalidReason: 'Automazioni solari disabilitate: imposta AUTOMATION_LATITUDE',
        lastRun: {
          at: Date.now(),
          triggerSource: 'sun:sunset',
          conditionsMet: false,
          executionTimeMs: 1,
          error: null,
          actions: [],
        },
      }),
    ]);

    expect(screen.getByText('Sole')).toBeInTheDocument();
    expect(screen.getByText('Condizioni non soddisfatte')).toBeInTheDocument();
    expect(screen.getByText('Non eseguibile')).toBeInTheDocument();
    expect(
      screen.getByText('Automazioni solari disabilitate: imposta AUTOMATION_LATITUDE'),
    ).toBeInTheDocument();
  });

  it('senza regole mostra lo stato vuoto', () => {
    renderTab([]);
    expect(screen.getByText('Nessuna automazione configurata.')).toBeInTheDocument();
  });
});

describe('AutomationsTab · switch e test', () => {
  it('disattiva la regola con lo switch rapido', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      jsonRoute({ automation: automation({ isActive: false }) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderTab();

    const toggle = screen.getByRole('switch', { name: 'Attiva o disattiva Luce corridoio di notte' });
    await user.click(toggle);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(`/api/automations/${RULE_ID}/toggle`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ isActive: false });
  });

  it('esegue il test forzato e aggiorna il badge con la latenza', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      jsonRoute({
        execution: {
          automationId: RULE_ID,
          triggerSource: 'test',
          conditionsMet: true,
          executionTimeMs: 7,
          error: null,
          actions: [
            {
              topic: 'cmnd/light_corridoio/dimmer',
              payload: '10',
              status: 'sent',
              durationMs: 1,
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderTab();

    await user.click(screen.getByRole('button', { name: /Esegui test/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(`/api/automations/${RULE_ID}/test`);
    expect(init.method).toBe('POST');

    expect(await screen.findByText('Successo · 7 ms')).toBeInTheDocument();
    expect(useToastStore.getState().toasts[0]?.title).toMatch(/Comando inviato in 7 ms/);
  });
});

describe('AutomationsTab · cronologia', () => {
  it('apre lo storico delle ultime esecuzioni con le azioni inviate', async () => {
    const user = userEvent.setup();
    const logs: AutomationLogEntry[] = [
      {
        id: '1',
        triggeredAt: Date.now() - 5 * 60_000,
        triggerSource: 'mqtt:stat/sensore_soggiorno/MOTION',
        conditionsMet: true,
        executionTimeMs: 38,
        error: null,
        // Forma piatta: è così che il pannello rende le esecuzioni registrate
        // prima dell'introduzione degli scenari.
        actions: [
          {
            topic: 'cmnd/light_corridoio/dimmer',
            payload: '10',
            status: 'sent',
            durationMs: 0,
          },
        ],
      },
      {
        id: '3',
        triggeredAt: Date.now() - 10 * 60_000,
        triggerSource: 'cron:0 23 * * *',
        conditionsMet: true,
        executionTimeMs: 210,
        error: null,
        actions: [
          {
            type: 'scenario',
            status: 'sent',
            scenarioId: 'goodnight',
            scenarioLabel: 'Buonanotte',
            durationMs: 205,
            commands: [
              {
                topic: 'zigbee2mqtt/living/main/set',
                payload: '{"state":"OFF"}',
                deviceId: 'light-living-main',
                status: 'sent',
                durationMs: 2,
              },
              {
                deviceId: 'sensor-living-temp',
                status: 'skipped',
                error: 'Il dispositivo non ha un topic di comando',
                durationMs: 0,
              },
            ],
          },
        ],
      },
      {
        id: '2',
        triggeredAt: Date.now() - 30 * 60_000,
        triggerSource: 'mqtt:stat/sensore_soggiorno/MOTION',
        conditionsMet: false,
        executionTimeMs: 2,
        error: null,
        actions: [],
      },
    ];
    vi.stubGlobal('fetch', vi.fn(jsonRoute({ automationId: RULE_ID, logs })));
    renderTab();

    await user.click(screen.getByRole('button', { name: /Cronologia/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cronologia · Luce corridoio di notte')).toBeInTheDocument();
    expect(await within(dialog).findByText('Successo · 38 ms')).toBeInTheDocument();
    expect(within(dialog).getByText('Condizioni non soddisfatte')).toBeInTheDocument();
    expect(within(dialog).getByText('cmnd/light_corridoio/dimmer')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Inviato').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Nessuna azione eseguita')).toBeInTheDocument();
    expect(
      within(dialog).getAllByText('Origine: mqtt:stat/sensore_soggiorno/MOTION'),
    ).toHaveLength(2);

    // Esecuzione con scenario: nome dello scenario, comandi tradotti e passo saltato.
    expect(within(dialog).getByText('Scenario: Buonanotte')).toBeInTheDocument();
    expect(within(dialog).getByText('2 comandi')).toBeInTheDocument();
    expect(within(dialog).getByText('Saltato')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Il dispositivo non ha un topic di comando'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Origine: cron:0 23 * * *')).toBeInTheDocument();
  });
});

describe('AutomationsTab · builder', () => {
  it('crea una regola completa: trigger MQTT, condizione su device e due azioni', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(jsonRoute({ automation: automation() }, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderTab([]);

    await user.click(screen.getByRole('button', { name: /Nuova automazione/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), 'Luce corridoio di notte');
    // I campi con suggerimento si cercano dal placeholder: l'etichetta del
    // builder contiene anche il testo di aiuto.
    await user.type(
      within(dialog).getByPlaceholderText('stat/sensore_soggiorno/MOTION'),
      'stat/sensore_soggiorno/MOTION',
    );
    await user.type(within(dialog).getByPlaceholderText('occupancy'), 'occupancy');
    await user.type(within(dialog).getByPlaceholderText('ON'), 'true');

    // Prima condizione: fascia oraria che scavalca la mezzanotte (23:00–06:00,
    // i valori iniziali del builder). Serve un gruppo che la contenga.
    await user.click(within(dialog).getByRole('button', { name: /Aggiungi gruppo/i }));
    await user.click(within(dialog).getByRole('button', { name: /Aggiungi condizione/i }));
    const typeSelect = within(dialog).getAllByLabelText('Tipo di condizione')[0] as HTMLSelectElement;
    expect(typeSelect.value).toBe('time_range');

    // Seconda condizione: stato di un dispositivo dal menu.
    await user.click(within(dialog).getByRole('button', { name: /Aggiungi condizione/i }));
    const selects = within(dialog).getAllByLabelText('Tipo di condizione');
    const deviceTypeSelect = selects[1] as HTMLSelectElement;
    await user.selectOptions(deviceTypeSelect, 'device_state');
    const deviceSelect = await within(dialog).findByLabelText('Dispositivo');
    await user.selectOptions(deviceSelect, 'light-living-main');

    // Azione compilata dal dispositivo: il topic arriva dal menu rapido.
    const preset = within(dialog).getByLabelText('Compila da dispositivo');
    await user.selectOptions(preset, 'light-living-main');
    await user.type(within(dialog).getByPlaceholderText('10'), '10');

    await user.click(within(dialog).getByRole('button', { name: 'Salva' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/automations');
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body)) as {
      name: string;
      triggerType: string;
      triggerConfig: Record<string, unknown>;
      conditions: Record<string, unknown>[];
      conditionGroups: Record<string, unknown>[][];
      actions: Record<string, unknown>[];
    };
    expect(body.name).toBe('Luce corridoio di notte');
    expect(body.triggerType).toBe('mqtt_state');
    expect(body.triggerConfig).toEqual({
      topic: 'stat/sensore_soggiorno/MOTION',
      payloadKey: 'occupancy',
      expectedValue: true,
    });
    expect(body.conditions).toContainEqual({ type: 'time_range', start: '23:00', end: '06:00' });
    expect(body.conditions).toContainEqual({
      type: 'device_state',
      deviceId: 'light-living-main',
      expectedState: 'OFF',
    });
    expect(body.actions[0]).toMatchObject({
      type: 'mqtt',
      topic: 'zigbee2mqtt/living/main/set',
      payload: '10',
      delayMs: 0,
    });
    expect(body.conditionGroups).toEqual([]);
  });

  it('costruisce un secondo gruppo in OR e un’azione che esegue uno scenario', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(jsonRoute({ automation: automation() }, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderTab([]);

    await user.click(screen.getByRole('button', { name: /Nuova automazione/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), 'Buonanotte se esco');
    await user.type(within(dialog).getByPlaceholderText('stat/sensore_soggiorno/MOTION'), 'stat/porta/ingresso');
    await user.type(within(dialog).getByPlaceholderText('ON'), 'true');

    // Gruppo 1: condizione di presenza. Gruppo 2: fascia oraria.
    await user.click(within(dialog).getByRole('button', { name: /Aggiungi gruppo/i }));
    await user.click(within(dialog).getByRole('button', { name: /Aggiungi condizione/i }));
    const firstType = within(dialog).getAllByLabelText('Tipo di condizione')[0] as HTMLSelectElement;
    await user.selectOptions(firstType, 'user_present');

    await user.click(within(dialog).getByRole('button', { name: /Aggiungi gruppo/i }));
    expect(within(dialog).getByText('oppure')).toBeInTheDocument();
    const addButtons = within(dialog).getAllByRole('button', { name: /Aggiungi condizione/i });
    await user.click(addButtons[1] as HTMLElement);

    // Azione: scenario del catalogo, non comando MQTT.
    await user.selectOptions(within(dialog).getByLabelText('Tipo di azione'), 'scenario');
    await user.selectOptions(within(dialog).getByLabelText('Scenario da eseguire'), 'goodnight');

    await user.click(within(dialog).getByRole('button', { name: 'Salva' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      conditions: Record<string, unknown>[];
      conditionGroups: Record<string, unknown>[][];
      actions: Record<string, unknown>[];
    };

    expect(body.conditions).toEqual([{ type: 'user_present', requireHome: true }]);
    expect(body.conditionGroups).toEqual([
      [{ type: 'time_range', start: '23:00', end: '06:00' }],
    ]);
    expect(body.actions).toEqual([{ type: 'scenario', scenarioId: 'goodnight', delayMs: 0 }]);
  });

  it('chiede uno scenario quando l’azione è di tipo scenario', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(jsonRoute({}, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderTab([]);

    await user.click(screen.getByRole('button', { name: /Nuova automazione/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), 'Senza scenario');
    await user.type(within(dialog).getByPlaceholderText('stat/sensore_soggiorno/MOTION'), 'stat/porta/ingresso');
    await user.selectOptions(within(dialog).getByLabelText('Tipo di azione'), 'scenario');
    await user.click(within(dialog).getByRole('button', { name: 'Salva' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Ogni azione di tipo scenario deve indicare uno scenario.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non invia nulla se il nome è vuoto', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(jsonRoute({}, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderTab([]);

    await user.click(screen.getByRole('button', { name: /Nuova automazione/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Salva' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Il nome è obbligatorio.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
