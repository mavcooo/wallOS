import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCameraStream, type UseCameraStreamOptions } from '@/hooks/useCameraStream';

function Harness(props: UseCameraStreamOptions) {
  const camera = useCameraStream(props);
  return (
    <div ref={camera.containerRef}>
      <video ref={camera.videoRef} data-testid="video" />
      <span data-testid="status">{camera.status}</span>
      <span data-testid="image">{camera.imageUrl ?? ''}</span>
    </div>
  );
}

class LoadedImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

class FakeMediaStream {
  addTrack = vi.fn();
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  private readonly callback: IntersectionObserverCallback;
  private target: Element | null = null;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  disconnect(): void {}

  trigger(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting, target: this.target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

class FakePeer extends EventTarget {
  static instances: FakePeer[] = [];

  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  addTransceiver = vi.fn();
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });

  constructor() {
    super();
    FakePeer.instances.push(this);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = {
      type: description.type ?? 'offer',
      sdp: description.sdp ?? '',
    };
  }

  async setRemoteDescription(_description: RTCSessionDescriptionInit): Promise<void> {
    this.connectionState = 'connected';
    const event = new Event('track') as Event & { track: MediaStreamTrack };
    Object.defineProperty(event, 'track', { value: { kind: 'video' } });
    this.dispatchEvent(event);
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

beforeEach(() => {
  vi.stubGlobal('Image', LoadedImage);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakePeer.instances = [];
  FakeIntersectionObserver.instances = [];
});

describe('useCameraStream', () => {
  it('non apre il flusso fuori dal viewport e lo chiude quando esce', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    render(
      <Harness
        streamUrl="http://proxy.local/api/webrtc?src=gate"
        snapshotUrl="http://proxy.local/frame.jpeg?src=gate"
        protocol="auto"
      />,
    );

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    const observer = FakeIntersectionObserver.instances[0];
    expect(observer).toBeDefined();

    act(() => observer?.trigger(true));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );

    act(() => observer?.trigger(false));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('idle'),
    );
    expect(screen.getByTestId('image')).toBeEmptyDOMElement();
  });

  it('usa lo snapshot quando WebRTC non è disponibile e sospende alla richiesta', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);

    const options: UseCameraStreamOptions = {
      streamUrl: 'http://proxy.local/api/webrtc?src=gate',
      snapshotUrl: 'http://proxy.local/frame.jpeg?src=gate',
      protocol: 'auto',
    };

    const view = render(<Harness {...options} />);

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );
    expect(screen.getByTestId('image').textContent).toContain('frame.jpeg');

    view.rerender(<Harness {...options} suspended />);

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('suspended'),
    );
    expect(screen.getByTestId('image')).toBeEmptyDOMElement();

    view.rerender(<Harness {...options} />);
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );
  });

  it('negozia WHEP e chiude peer e sessione allo unmount', async () => {
    FakePeer.instances = [];
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('answer-sdp', {
        status: 200,
        headers: { Location: 'http://proxy.local/api/webrtc/session/7' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(
      <Harness
        streamUrl="http://proxy.local/api/webrtc?src=gate"
        protocol="webrtc"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );

    const peer = FakePeer.instances[0];
    expect(peer).toBeDefined();
    expect(peer?.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy.local/api/webrtc?src=gate',
      expect.objectContaining({
        method: 'POST',
        body: 'offer-sdp',
        headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
      }),
    );

    view.unmount();

    expect(peer?.close).toHaveBeenCalled();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://proxy.local/api/webrtc/session/7',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
