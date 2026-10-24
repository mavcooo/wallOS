import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDevice: vi.fn(),
  updateDevice: vi.fn(),
  createRoom: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
  addFilter: vi.fn(() => true),
  removeFilter: vi.fn(),
}));

vi.mock('@/hooks/useTopologyMutations', () => ({
  useCreateDevice: () => ({ mutateAsync: mocks.createDevice, isPending: false }),
  useUpdateDevice: () => ({ mutateAsync: mocks.updateDevice, isPending: false }),
  useCreateRoom: () => ({ mutateAsync: mocks.createRoom, isPending: false }),
}));

vi.mock('@/hooks/useMqttSniffer', () => ({
  useMqttSniffer: () => ({
    active: true,
    filters: ['tele/#'],
    messages: [
      {
        id: 'sniff-1',
        direction: 'in',
        topic: 'zigbee2mqtt/pianta',
        payload: 'ON',
        qos: 0,
        retain: false,
        at: Date.now(),
      },
    ],
    start: mocks.start,
    stop: mocks.stop,
    toggle: vi.fn(),
    clear: mocks.clear,
    addFilter: mocks.addFilter,
    removeFilter: mocks.removeFilter,
  }),
}));

const { DeviceFormDialog } = await import('@/components/settings/DeviceFormDialog');

const ROOMS = [{ id: 'salotto', label: 'Salotto', shortLabel: 'Salotto' }];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.createDevice.mockResolvedValue({});
  mocks.updateDevice.mockResolvedValue({});
  mocks.createRoom.mockResolvedValue({
    room: { id: 'garage', label: 'Garage', shortLabel: 'Garage' },
  });
});

describe('DeviceFormDialog', () => {
  it('crea un dispositivo manuale con i topic configurati', async () => {
    const onOpenChange = vi.fn();
    render(
      <DeviceFormDialog
        open
        onOpenChange={onOpenChange}
        rooms={ROOMS}
      />,
    );

    await userEvent.type(screen.getByLabelText('Nome'), 'Luce garage');
    await userEvent.type(
      screen.getByLabelText('Topic di stato'),
      'zigbee2mqtt/garage',
    );
    await userEvent.type(
      screen.getByLabelText('Topic di comando'),
      'zigbee2mqtt/garage/set',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Crea dispositivo' }));

    expect(mocks.createDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'luce-garage',
        roomId: 'salotto',
        name: 'Luce garage',
        type: 'light',
        adapter: 'zigbee2mqtt',
        stateTopic: 'zigbee2mqtt/garage',
        commandTopic: 'zigbee2mqtt/garage/set',
        favorite: false,
        protected: false,
        displayOrder: 0,
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('crea una telecamera con endpoint WebRTC e fallback snapshot', async () => {
    render(<DeviceFormDialog open onOpenChange={vi.fn()} rooms={ROOMS} />);

    await userEvent.type(screen.getByLabelText('Nome'), 'Ingresso');
    await userEvent.selectOptions(screen.getByLabelText('Tipo'), 'camera');
    await userEvent.type(
      screen.getByLabelText('URL del flusso'),
      'http://192.168.0.59:1984/api/webrtc?src=ingresso',
    );
    await userEvent.type(
      screen.getByLabelText('URL snapshot (opzionale)'),
      'http://192.168.0.59:1984/api/frame.jpeg?src=ingresso',
    );
    await userEvent.selectOptions(screen.getByLabelText('Protocollo'), 'hls');
    await userEvent.selectOptions(screen.getByLabelText('Formato'), '4:3');
    await userEvent.click(screen.getByRole('button', { name: 'Crea dispositivo' }));

    expect(mocks.createDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ingresso',
        type: 'camera',
        stateTopic: '',
        streamUrl: 'http://192.168.0.59:1984/api/webrtc?src=ingresso',
        snapshotUrl: 'http://192.168.0.59:1984/api/frame.jpeg?src=ingresso',
        streamProtocol: 'hls',
        aspectRatio: '4:3',
      }),
    );
  }, 15_000);

  it('blocca i wildcard nel topic di stato', async () => {
    render(<DeviceFormDialog open onOpenChange={vi.fn()} rooms={ROOMS} />);

    await userEvent.type(screen.getByLabelText('Nome'), 'Sensore');
    await userEvent.type(screen.getByLabelText('Topic di stato'), 'tele/#');
    await userEvent.click(screen.getByRole('button', { name: 'Crea dispositivo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /wildcard/i,
    );
    expect(mocks.createDevice).not.toHaveBeenCalled();
  });

  it('compila adapter e topic dal messaggio catturato dallo sniffer', async () => {
    render(<DeviceFormDialog open onOpenChange={vi.fn()} rooms={ROOMS} />);

    await userEvent.click(screen.getByRole('tab', { name: /Ascolta e cattura/ }));
    expect(screen.getByText('zigbee2mqtt/pianta')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Usa questo topic/ }));

    expect(screen.getByLabelText('Nome')).toHaveValue('Pianta');
    expect(screen.getByLabelText('Topic di stato')).toHaveValue('zigbee2mqtt/pianta');
    expect(screen.getByLabelText('Topic di comando')).toHaveValue(
      'zigbee2mqtt/pianta/set',
    );
    expect(screen.getByLabelText('Topic availability')).toHaveValue(
      'zigbee2mqtt/pianta/availability',
    );
  });
});
