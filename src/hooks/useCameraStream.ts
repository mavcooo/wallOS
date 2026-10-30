import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';

import {
  cameraBackoffMs,
  cameraCandidates,
  normalizeStreamUrl,
  waitForIceGathering,
  whepSessionUrl,
  withCacheBuster,
  type CameraCandidate,
  type CameraStreamStatus,
  type CameraTransport,
} from '@/lib/cameraStream';
import { useHomeStore } from '@/store/homeStore';
import type { CameraProtocol } from '@/types/device';

const SNAPSHOT_INTERVAL_MS = 1_500;
const MEDIA_TIMEOUT_MS = 12_000;

export interface UseCameraStreamOptions {
  streamUrl: string;
  snapshotUrl?: string | undefined;
  protocol: CameraProtocol;
  /**
   * `false` = player smontato e risorse rilasciate (screensaver kiosk attivo).
   * Omesso, il gate è lo stato del dimmer (`ui.screenDimmed` in HomeStore).
   */
  enabled?: boolean;
  /**
   * Sospensione decisa dal contenitore per un motivo diverso dal dimmer (es.
   * modale a schermo intero aperta sopra la card): stessa pulizia di `enabled`.
   */
  suspended?: boolean;
  /** Frequenza del fallback JPEG (default 1.5 s, cioè meno di 1 fps). */
  snapshotIntervalMs?: number;
}

export interface UseCameraStreamResult {
  /** Da applicare al contenitore osservato dall'IntersectionObserver. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Da applicare al <video> per WebRTC e HLS. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: CameraStreamStatus;
  transport: CameraTransport | null;
  /** Sorgente da mostrare in modalità MJPEG/snapshot. */
  imageUrl: string | null;
  error: string | null;
  retry: () => void;
  handleImageLoad: () => void;
  handleImageError: () => void;
}

function mediaErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Camera stream unavailable';
}

/** jsdom e browser datati possono restituire undefined invece di una Promise. */
function safePlay(video: HTMLVideoElement): void {
  try {
    const result = video.play();
    if (result) void result.catch(() => {});
  } catch {
    // Autoplay negato: il primo tap sulla card porterà in modale.
  }
}

/**
 * Player camera locale con attivazione pigra.
 *
 * Regole di risparmio:
 * - il flusso esiste solo quando il contenitore è nel viewport, la pagina è
 *   visibile e il dimmer kiosk è spento;
 * - WebRTC chiude peer connection e sessione WHEP sul server;
 * - HLS distrugge l'istanza e libera il buffer del <video>;
 * - lo snapshot usa una sola richiesta ogni `snapshotIntervalMs`, mai un timer
 *   per frame.
 */
export function useCameraStream({
  streamUrl,
  snapshotUrl,
  protocol,
  enabled,
  suspended = false,
  snapshotIntervalMs = SNAPSHOT_INTERVAL_MS,
}: UseCameraStreamOptions): UseCameraStreamResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  /**
   * MediaStream remoto della sessione WHEP. Vive in un ref perché allo unmount
   * React azzera `videoRef` **prima** delle cleanup degli effetti: senza
   * questo riferimento le tracce resterebbero vive fino alla GC.
   */
  const remoteStreamRef = useRef<MediaStream | null>(null);
  /** Ultimo nodo `<video>` montato: vedi l'effetto più sotto. */
  const videoNodeRef = useRef<HTMLVideoElement | null>(null);
  /**
   * Lo standby del pannello vive in HomeStore (`ui.screenDimmed`), dove lo
   * scrive `useKioskDimmer`. Qui si legge quello stato e non si istanzia un
   * secondo `useKioskDimmer`: una istanza per ogni telecamera aggiungerebbe un
   * timer di inattività e sei listener `window` a testa, e ciascuna potrebbe a
   * sua volta mandare in standby l'intero pannello.
   */
  const screenDimmed = useHomeStore((state) => state.ui.screenDimmed);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const [status, setStatus] = useState<CameraStreamStatus>('idle');
  const [transport, setTransport] = useState<CameraTransport | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const attemptRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  /**
   * Distruzione profonda del player: chiude la peer connection, distrugge
   * l'istanza Hls, ferma ogni `MediaStreamTrack` (send/receive e sorgente del
   * `<video>`) e svuota l'elemento video forzandone il reload, che è ciò che
   * libera i buffer del decoder hardware. Idempotente: si può chiamare su ogni
   * ramo di uscita senza sapere quale trasporto fosse attivo.
   */
  const teardownStream = useCallback(() => {
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      // Ogni passo è isolato: un `getSenders` assente o che lancia non deve
      // impedire `close()`, che è la parte che libera davvero la connessione.
      try {
        for (const sender of peer.getSenders?.() ?? []) sender.track?.stop();
        for (const receiver of peer.getReceivers?.() ?? []) receiver.track?.stop();
      } catch (err) {
        console.warn('[useCameraStream] stop delle tracce WebRTC fallito:', err);
      }
      try {
        peer.close();
      } catch (err) {
        console.warn('[useCameraStream] chiusura della RTCPeerConnection fallita:', err);
      }
    }

    const hls = hlsRef.current;
    hlsRef.current = null;
    if (hls) {
      try {
        hls.detachMedia();
      } catch (err) {
        console.warn('[useCameraStream] detach di Hls fallito:', err);
      }
      try {
        hls.destroy();
      } catch (err) {
        console.warn('[useCameraStream] distruzione di Hls fallita:', err);
      }
    }

    const remote = remoteStreamRef.current;
    remoteStreamRef.current = null;
    if (remote) {
      try {
        for (const track of remote.getTracks()) track.stop();
      } catch (err) {
        console.warn('[useCameraStream] stop delle tracce remote fallito:', err);
      }
    }

    // Allo unmount React azzera `videoRef` prima delle cleanup: il nodo resta
    // comunque raggiungibile da `videoNodeRef` e viene svuotato lo stesso.
    const video = videoRef.current ?? videoNodeRef.current;
    if (!video) return;
    try {
      video.pause();
      const source = video.srcObject;
      if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
        for (const track of source.getTracks()) track.stop();
      }
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    } catch (err) {
      console.warn('[useCameraStream] reset del video element fallito:', err);
    }
  }, []);

  // Memorizza il nodo `<video>`: i ref di React vengono azzerati prima delle
  // cleanup degli effetti, quindi la distruzione profonda non può fidarsi solo
  // di `videoRef.current`.
  useEffect(() => {
    if (videoRef.current) videoNodeRef.current = videoRef.current;
  });

  // Il flusso non viene nemmeno montato finché il widget non è visibile.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setVisible(Boolean(entry?.isIntersecting));
      },
      { threshold: 0.2 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Un nuovo endpoint riparte sempre dal primo trasporto.
  useEffect(() => {
    attemptRef.current = 0;
  }, [streamUrl, snapshotUrl, protocol]);

  // Uscendo dal viewport o entrando in standby non conserviamo l'indice di
  // fallback: al risveglio si ritenta la priorità più alta.
  useEffect(() => {
    if (!visible || suspended || screenDimmed) attemptRef.current = 0;
  }, [visible, suspended, screenDimmed]);

  const retry = useCallback(() => {
    attemptRef.current = 0;
    setError(null);
    setRetryToken((value) => value + 1);
  }, []);

  const handleImageLoad = useCallback(() => {
    attemptRef.current = 0;
    setStatus('live');
    setError(null);
  }, []);

  const handleImageError = useCallback(() => {
    attemptRef.current += 1;
    setStatus('error');
    setError('Snapshot unavailable');
    setRetryToken((value) => value + 1);
  }, []);

  /** Gate del dimmer: l'opzione esplicita vince, altrimenti vale lo stato kiosk. */
  const streamEnabled = enabled ?? !screenDimmed;
  const active = Boolean(streamUrl) && streamEnabled && visible && pageVisible && !suspended;

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;
    let activeCleanup: (() => void) | null = null;

    const clearRetry = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const registerCleanup = (cleanup: () => void) => {
      activeCleanup = cleanup;
      cleanupRef.current = cleanup;
    };

    const disposeActive = () => {
      const cleanup = activeCleanup;
      activeCleanup = null;
      if (cleanupRef.current === cleanup) cleanupRef.current = null;
      cleanup?.();
    };

    const scheduleRetry = (delayMs: number, advanceAttempt = true) => {
      if (disposed) return;
      setStatus('reconnecting');
      if (advanceAttempt) attemptRef.current += 1;
      clearRetry();
      retryTimer = window.setTimeout(() => {
        if (!disposed) setRetryToken((value) => value + 1);
      }, delayMs);
    };

    const startWebrtc = async (sourceUrl: string): Promise<void> => {
      if (typeof RTCPeerConnection === 'undefined') {
        throw new Error('WebRTC non supportato da questo browser');
      }

      const endpoint = normalizeStreamUrl(sourceUrl);
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      const remote = new MediaStream();
      remoteStreamRef.current = remote;
      const video = videoRef.current;
      const controller = new AbortController();
      let sessionUrl: string | null = null;
      let cleaned = false;
      let disconnectTimer: number | null = null;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        controller.abort();
        if (disconnectTimer !== null) window.clearTimeout(disconnectTimer);
        peer.removeEventListener('track', onTrack);
        peer.removeEventListener('connectionstatechange', onState);
        // Peer, tracce e buffer del <video> li libera `teardownStream`.
        teardownStream();
        if (sessionUrl) {
          void fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
        }
      };
      registerCleanup(cleanup);

      const onTrack = (event: RTCTrackEvent) => {
        if (disposed || cleaned) return;
        remote.addTrack(event.track);
        if (video) {
          video.srcObject = remote;
          safePlay(video);
        }
        attemptRef.current = 0;
        setStatus('live');
        setError(null);
      };

      const onState = () => {
        if (disposed || cleaned) return;
        if (peer.connectionState === 'connected' && disconnectTimer !== null) {
          window.clearTimeout(disconnectTimer);
          disconnectTimer = null;
        }
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          setStatus('reconnecting');
          if (disconnectTimer !== null) return;
          disconnectTimer = window.setTimeout(() => {
            if (disposed || cleaned) return;
            // Una sessione già viva riparte dallo stesso trasporto, non dal
            // fallback snapshot: il calo può essere stato transitorio.
            attemptRef.current = 0;
            disposeActive();
            scheduleRetry(0, false);
          }, 800);
        }
      };

      peer.addEventListener('track', onTrack);
      peer.addEventListener('connectionstatechange', onState);
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('audio', { direction: 'recvonly' });

      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGathering(peer);
        const local = peer.localDescription;
        if (!local) throw new Error('SDP locale non disponibile');

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
          body: local.sdp,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`WHEP ${response.status}`);
        sessionUrl = whepSessionUrl(response, endpoint);
        const answer = await response.text();
        await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (cause) {
        cleanup();
        throw cause;
      }
    };

    const waitForVideo = (video: HTMLVideoElement): Promise<void> =>
      new Promise((resolve, reject) => {
        if (video.readyState >= 2) {
          resolve();
          return;
        }
        const timer = window.setTimeout(() => {
          finish();
          reject(new Error('Timeout del flusso video'));
        }, MEDIA_TIMEOUT_MS);
        const finish = () => {
          window.clearTimeout(timer);
          video.removeEventListener('loadeddata', onReady);
          video.removeEventListener('playing', onReady);
          video.removeEventListener('error', onError);
        };
        const onReady = () => {
          finish();
          resolve();
        };
        const onError = () => {
          finish();
          reject(new Error('Flusso video non leggibile'));
        };
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('playing', onReady);
        video.addEventListener('error', onError);
      });

    const startHls = async (sourceUrl: string): Promise<void> => {
      const video = videoRef.current;
      if (!video) throw new Error('Elemento video non disponibile');
      const source = normalizeStreamUrl(sourceUrl);
      let cleaned = false;
      let settled = false;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        video.removeEventListener('error', onVideoError);
        teardownStream();
      };
      registerCleanup(cleanup);

      function onVideoError(): void {
        if (!settled || disposed || cleaned) return;
        attemptRef.current = 0;
        cleanup();
        disposeActive();
        scheduleRetry(0, false);
      }
      video.addEventListener('error', onVideoError);

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source;
      } else {
        // Build "light": niente EME, sottotitoli o audio alternativo; il
        // player di sorveglianza usa solo video/audio del flusso principale.
        const module = await import('hls.js/light');
        if (disposed || cleaned) return;
        const HlsPlayer = module.default;
        if (!HlsPlayer.isSupported()) throw new Error('HLS non supportato');
        const player = new HlsPlayer({
          lowLatencyMode: true,
          backBufferLength: 20,
          maxBufferLength: 12,
          enableWorker: true,
        });
        hlsRef.current = player;
        player.loadSource(source);
        player.attachMedia(video);
        player.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (!data.fatal || disposed) return;
          if (!settled) {
            // La negoziazione è ancora in corso: sblocca waitForVideo e lascia
            // al loop la scelta del prossimo trasporto.
            cleanup();
            video.dispatchEvent(new Event('error'));
            return;
          }
          attemptRef.current = 0;
          disposeActive();
          scheduleRetry(0, false);
        });
      }

      try {
        safePlay(video);
        await waitForVideo(video);
        if (disposed) return;
        settled = true;
        attemptRef.current = 0;
        setStatus('live');
        setError(null);
      } catch (cause) {
        cleanup();
        throw cause;
      }
    };

    const startMjpeg = (sourceUrl: string): void => {
      const video = videoRef.current;
      if (video) {
        video.srcObject = null;
        video.removeAttribute('src');
      }
      setImageUrl(withCacheBuster(sourceUrl, Date.now()));
      setStatus('connecting');
      const timer = window.setTimeout(() => {
        if (!disposed) handleImageError();
      }, MEDIA_TIMEOUT_MS);
      registerCleanup(() => window.clearTimeout(timer));
    };

    const loadSnapshot = (url: string): Promise<boolean> =>
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = url;
      });

    const startSnapshot = async (sourceUrl: string): Promise<void> => {
      let stopped = false;
      let timer: number | null = null;
      const interval = Math.max(500, snapshotIntervalMs);
      const video = videoRef.current;
      if (video) {
        video.srcObject = null;
        video.removeAttribute('src');
        video.load();
      }

      const cleanup = () => {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
      };
      registerCleanup(cleanup);

      const load = async (): Promise<boolean> => {
        const url = withCacheBuster(sourceUrl, Date.now());
        const ok = await loadSnapshot(url);
        if (stopped || disposed) return false;
        if (ok) {
          attemptRef.current = 0;
          setImageUrl(url);
          setStatus('live');
          setError(null);
        }
        return ok;
      };

      const ok = await load();
      if (!ok) {
        cleanup();
        throw new Error('Snapshot non disponibile');
      }

      const poll = () => {
        timer = window.setTimeout(async () => {
          if (stopped || disposed) return;
          const success = await load();
          if (stopped || disposed) return;
          if (!success) {
            disposeActive();
            scheduleRetry(cameraBackoffMs(attemptRef.current));
            return;
          }
          poll();
        }, interval);
      };
      poll();
    };

    const startTransport = async (candidate: CameraCandidate): Promise<void> => {
      setTransport(candidate.transport);
      setImageUrl(null);
      setError(null);
      if (candidate.transport === 'snapshot') return startSnapshot(candidate.url);
      setStatus('connecting');
      if (candidate.transport === 'webrtc') return startWebrtc(candidate.url);
      if (candidate.transport === 'hls') return startHls(candidate.url);
      startMjpeg(candidate.url);
    };

    const run = async () => {
      if (!active) {
        // Nessun trasporto deve sopravvivere a questo ramo, nemmeno se è nato
        // dopo la cleanup dell'effetto precedente.
        teardownStream();
        setStatus(suspended || !streamEnabled ? 'suspended' : 'idle');
        setTransport(null);
        setImageUrl(null);
        return;
      }

      setStatus(attemptRef.current > 0 ? 'reconnecting' : 'connecting');
      const candidates = cameraCandidates(streamUrl, protocol, snapshotUrl);
      const startIndex = Math.min(attemptRef.current, candidates.length - 1);
      let lastError: unknown = null;

      for (let index = startIndex; index < candidates.length; index += 1) {
        if (disposed) return;
        const candidate = candidates[index];
        if (!candidate) continue;
        try {
          await startTransport(candidate);
          return;
        } catch (cause) {
          lastError = cause;
          disposeActive();
          if (disposed) return;
        }
      }

      if (disposed) return;
      setStatus('error');
      setError(mediaErrorMessage(lastError));
      scheduleRetry(cameraBackoffMs(attemptRef.current));
    };

    void run();

    return () => {
      disposed = true;
      clearRetry();
      disposeActive();
    };
  }, [
    active,
    streamEnabled,
    suspended,
    streamUrl,
    snapshotUrl,
    protocol,
    snapshotIntervalMs,
    retryToken,
    handleImageError,
    teardownStream,
  ]);

  // Cambio di visibilità/dimmer: la cleanup dell'effetto chiude subito peer,
  // HLS e timer. Allo unmount la distruzione è profonda anche per i trasporti
  // che non hanno registrato una cleanup (import di hls.js ancora in volo).
  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      teardownStream();
    },
    [teardownStream],
  );

  return {
    containerRef,
    videoRef,
    status,
    transport,
    imageUrl,
    error,
    retry,
    handleImageLoad,
    handleImageError,
  };
}
