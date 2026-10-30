import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCameraStream, type UseCameraStreamOptions } from '@/hooks/useCameraStream';
import { useHomeStore } from '@/store/homeStore';

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
  private tracks: { stop: () => void }[] = [];
  addTrack = vi.fn((track: { stop: () => void }) => {
    this.tracks.push(track);
  });
  getTracks = vi.fn(() => [...this.tracks]);
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
  /** Traccia consegnata dall'evento `track` e finita in `video.srcObject`. */
  readonly mediaTrack = { kind: 'video' as const, stop: vi.fn() };
  readonly senderTrack = { stop: vi.fn() };
  readonly receiverTrack = { stop: vi.fn() };
  getSenders = vi.fn(() => [{ track: this.senderTrack }]);
  getReceivers = vi.fn(() => [{ track: this.receiverTrack }]);

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
    Object.defineProperty(event, 'track', { value: this.mediaTrack });
    this.dispatchEvent(event);
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

/**
 * `hls.js/light` finto: `attachMedia` risveglia `waitForVideo` con l'evento
 * `playing`, come farebbe un manifest già bufferizzato sulla rete locale.
 */
const hlsMock = vi.hoisted(() => {
  class FakeHls {
    static instances: FakeHls[] = [];
    /** Falso di default: solo i test HLS lo accendono, gli altri cascano sul fallback. */
    static supported = false;
    static isSupported = () => FakeHls.supported;
    static Events = { ERROR: 'hlsError' };

    destroyed = false;
    detached = false;
    loadSource = vi.fn();
    attachMedia = vi.fn((video: HTMLVideoElement) => {
      window.setTimeout(() => video.dispatchEvent(new Event('playing')), 0);
    });
    detachMedia = vi.fn(() => {
      this.detached = true;
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    on = vi.fn();
    readonly config: Record<string, unknown>;

    constructor(config: Record<string, unknown>) {
      this.config = config;
      FakeHls.instances.push(this);
    }
  }

  return { FakeHls };
});

vi.mock('hls.js/light', () => ({ default: hlsMock.FakeHls }));

const HLS_URL = 'http://proxy.local/live/gate.m3u8';

function videoElement(): HTMLVideoElement {
  return screen.getByTestId('video') as HTMLVideoElement;
}

beforeEach(() => {
  vi.stubGlobal('Image', LoadedImage);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  useHomeStore.setState((state) => ({ ui: { ...state.ui, screenDimmed: false } }));
});

afterEach(() => {
  // Smonta mentre le API media sono ancora stub: il teardown reale non deve
  // finire nelle implementazioni "not implemented" di jsdom.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakePeer.instances = [];
  FakeIntersectionObserver.instances = [];
  hlsMock.FakeHls.instances = [];
  hlsMock.FakeHls.supported = false;
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

  it('distrugge Hls e svuota il decoder quando enabled passa a false, poi riaggancia', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    hlsMock.FakeHls.supported = true;
    const loadSpy = HTMLMediaElement.prototype.load as unknown as ReturnType<typeof vi.fn>;

    const view = render(<Harness streamUrl={HLS_URL} protocol="hls" enabled />);
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );

    const first = hlsMock.FakeHls.instances[0];
    expect(first).toBeDefined();
    expect(first?.attachMedia).toHaveBeenCalledWith(videoElement());

    view.rerender(<Harness streamUrl={HLS_URL} protocol="hls" enabled={false} />);

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('suspended'),
    );
    // Nessun trasporto vivo: istanza distrutta, elemento video azzerato e
    // ricaricato (è `load()` a liberare i buffer del decoder).
    expect(first?.detached).toBe(true);
    expect(first?.destroyed).toBe(true);
    expect(videoElement().srcObject).toBeNull();
    expect(videoElement().getAttribute('src')).toBeNull();
    expect(loadSpy).toHaveBeenCalled();

    view.rerender(<Harness streamUrl={HLS_URL} protocol="hls" enabled />);

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );
    expect(hlsMock.FakeHls.instances).toHaveLength(2);
    expect(hlsMock.FakeHls.instances[1]?.destroyed).toBe(false);
  });

  it('ferma tutte le tracce WebRTC e chiude la peer connection allo standby', async () => {
    FakePeer.instances = [];
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('answer-sdp', {
          status: 200,
          headers: { Location: 'http://proxy.local/api/webrtc/session/9' },
        }),
      ),
    );

    const view = render(
      <Harness streamUrl="http://proxy.local/api/webrtc?src=gate" protocol="webrtc" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );

    const peer = FakePeer.instances[0];
    expect(peer).toBeDefined();
    expect(videoElement().srcObject).not.toBeNull();

    view.rerender(
      <Harness streamUrl="http://proxy.local/api/webrtc?src=gate" protocol="webrtc" enabled={false} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('suspended'),
    );
    expect(peer?.getSenders).toHaveBeenCalled();
    expect(peer?.getReceivers).toHaveBeenCalled();
    expect(peer?.senderTrack.stop).toHaveBeenCalled();
    expect(peer?.receiverTrack.stop).toHaveBeenCalled();
    // La traccia arrivata dal flusso remoto vive in `video.srcObject`.
    expect(peer?.mediaTrack.stop).toHaveBeenCalled();
    expect(peer?.close).toHaveBeenCalled();
    expect(videoElement().srcObject).toBeNull();
  });

  it('usa lo stato del dimmer kiosk quando enabled non viene passato', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    hlsMock.FakeHls.supported = true;
    useHomeStore.setState((state) => ({ ui: { ...state.ui, screenDimmed: true } }));

    render(<Harness streamUrl={HLS_URL} protocol="hls" />);

    expect(screen.getByTestId('status')).toHaveTextContent('suspended');
    // Nemmeno un manifest richiesto: il player non viene istanziato.
    expect(hlsMock.FakeHls.instances).toHaveLength(0);
    expect(videoElement().getAttribute('src')).toBeNull();

    act(() => {
      useHomeStore.setState((state) => ({ ui: { ...state.ui, screenDimmed: false } }));
    });

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );
    expect(hlsMock.FakeHls.instances).toHaveLength(1);
  });

  it('allo unmount non lascia listener né risorse del player', async () => {
    FakePeer.instances = [];
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('answer-sdp', {
          status: 200,
          headers: { Location: 'http://proxy.local/api/webrtc/session/11' },
        }),
      ),
    );
    const view = render(
      <Harness streamUrl="http://proxy.local/api/webrtc?src=gate" protocol="webrtc" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );
    const video = videoElement();
    const peer = FakePeer.instances[0];
    const peerRemove = vi.spyOn(peer as FakePeer, 'removeEventListener');

    view.unmount();

    expect(peerRemove).toHaveBeenCalledWith('track', expect.any(Function));
    expect(peerRemove).toHaveBeenCalledWith('connectionstatechange', expect.any(Function));
    expect(peer?.close).toHaveBeenCalled();
    expect(peer?.mediaTrack.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
  });

  it('un flusso HLS non resta attivo dopo l’unmount', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    hlsMock.FakeHls.supported = true;
    const removeSpy = vi.spyOn(HTMLMediaElement.prototype, 'removeEventListener');

    const view = render(<Harness streamUrl={HLS_URL} protocol="hls" />);
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('live'),
    );
    const hls = hlsMock.FakeHls.instances[0];

    view.unmount();

    expect(hls?.detached).toBe(true);
    expect(hls?.destroyed).toBe(true);
    // Il listener di errore sul <video> non resta appeso al nodo rimosso.
    expect(removeSpy).toHaveBeenCalledWith('error', expect.any(Function));
    expect(document.querySelector('video')).toBeNull();
  });
});
