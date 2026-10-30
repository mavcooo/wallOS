import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseCameraStreamResult } from '@/hooks/useCameraStream';
import { useHomeStore } from '@/store/homeStore';
import { deviceOf } from '@/test/fixtures';

const camera = vi.hoisted(
  () =>
    ({
      containerRef: { current: null },
      videoRef: { current: null },
      status: 'live',
      transport: 'webrtc',
      imageUrl: null,
      error: null,
      retry: vi.fn(),
      handleImageLoad: vi.fn(),
      handleImageError: vi.fn(),
    }) as unknown as UseCameraStreamResult,
);

vi.mock('@/hooks/useCameraStream', () => ({
  useCameraStream: () => camera,
}));

const { CameraCard } = await import('@/components/widgets/CameraCard');
const device = deviceOf('camera-outdoor-gate', 'camera');

beforeEach(() => {
  localStorage.clear();
  camera.status = 'live';
  useHomeStore.setState((state) => ({ ui: { ...state.ui, screenDimmed: false } }));
});

describe('CameraCard', () => {
  it('mostra badge live, stanza e trasporto', () => {
    render(<CameraCard device={device} roomName="Esterno" />);

    expect(screen.getByText(device.name)).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText('Esterno · WebRTC')).toBeInTheDocument();
  });

  it('mostra lo stato di pausa, non “Connessione…”, con il flusso sospeso', async () => {
    camera.status = 'suspended';
    render(<CameraCard device={device} roomName="Esterno" />);

    expect(screen.getByText('In pausa')).toBeInTheDocument();
    expect(screen.queryByText('Connessione…')).not.toBeInTheDocument();
    // Icona di pausa al posto dello spinner di caricamento.
    expect(screen.getByTestId('camera-paused')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: `Apri la telecamera ${device.name}` }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('In pausa')).toBeInTheDocument();
    expect(within(dialog).getByTestId('camera-modal-paused')).toBeInTheDocument();
    expect(screen.queryByText('Connessione…')).not.toBeInTheDocument();
  });

  it('mostra lo spinner, non l’icona di pausa, mentre connette', () => {
    camera.status = 'connecting';
    render(<CameraCard device={device} roomName="Esterno" />);

    expect(screen.getByText('Connessione…')).toBeInTheDocument();
    expect(screen.queryByTestId('camera-paused')).not.toBeInTheDocument();
  });

  it('apre la modale fullscreen e la chiude dal controllo touch', async () => {
    render(<CameraCard device={device} roomName="Esterno" />);

    await userEvent.click(
      screen.getByRole('button', { name: `Apri la telecamera ${device.name}` }),
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Chiudi telecamera' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
