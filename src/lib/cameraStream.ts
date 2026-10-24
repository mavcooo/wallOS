import type { CameraProtocol } from '@/types/device';

/** Trasporto effettivamente usato dal player. */
export type CameraTransport = 'webrtc' | 'hls' | 'mjpeg' | 'snapshot';

/** Trasporto + URL concreto: il fallback go2rtc cambia endpoint, non host. */
export interface CameraCandidate {
  transport: CameraTransport;
  url: string;
}

/** Stato osservabile dalla card e dalla modale. */
export type CameraStreamStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'error'
  | 'suspended';

/**
 * I browser non parlano RTSP: il campo accetta solo endpoint HTTP(S) del proxy
 * locale. Lo schema `webrtc://` è una comodità di configurazione e viene
 * convertito nell'equivalente HTTP prima della negoziazione WHEP.
 */
export function normalizeStreamUrl(raw: string): string {
  const value = raw.trim();
  if (value.toLowerCase().startsWith('webrtc://')) {
    return `http://${value.slice('webrtc://'.length)}`;
  }
  return value;
}

/** Deduce il trasporto quando il device è configurato in modalità `auto`. */
export function inferCameraTransport(
  rawUrl: string,
  protocol: CameraProtocol,
): CameraTransport {
  if (protocol !== 'auto') return protocol;
  const path = normalizeStreamUrl(rawUrl).split('?')[0]?.toLowerCase() ?? '';
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mjpg') || path.endsWith('.mjpeg') || path.endsWith('.jpeg')) {
    return 'mjpeg';
  }
  return 'webrtc';
}

/**
 * go2rtc espone gli stessi stream su tre endpoint. Riscrivere solo il path
 * permette a un utente che ha configurato il WHEP di ottenere HLS e JPEG senza
 * duplicare host, porta e token nella configurazione.
 */
export function go2rtcVariant(
  rawUrl: string,
  endpoint: 'stream.m3u8' | 'frame.jpeg',
): string | null {
  try {
    const url = new URL(normalizeStreamUrl(rawUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!/\/api\/(webrtc|stream\.m3u8|frame\.jpeg)$/i.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(
      /\/api\/(webrtc|stream\.m3u8|frame\.jpeg)$/i,
      `/api/${endpoint}`,
    );
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Costruisce la catena concreta dei tentativi:
 * WebRTC → HLS → snapshot per go2rtc, oppure il protocollo scelto + gli
 * endpoint derivabili. Un proxy generico senza varianti resta sul suo
 * trasporto e usa il backoff.
 */
export function cameraCandidates(
  rawUrl: string,
  protocol: CameraProtocol,
  snapshotUrl?: string,
): CameraCandidate[] {
  const primary = inferCameraTransport(rawUrl, protocol);
  const primaryUrl =
    primary === 'hls'
      ? (go2rtcVariant(rawUrl, 'stream.m3u8') ?? normalizeStreamUrl(rawUrl))
      : normalizeStreamUrl(rawUrl);
  const candidates: CameraCandidate[] = [{ transport: primary, url: primaryUrl }];

  if (primary === 'webrtc') {
    const hls = go2rtcVariant(rawUrl, 'stream.m3u8');
    if (hls) candidates.push({ transport: 'hls', url: hls });
  }

  if (snapshotUrl) {
    candidates.push({ transport: 'snapshot', url: normalizeStreamUrl(snapshotUrl) });
  } else {
    const frame = go2rtcVariant(rawUrl, 'frame.jpeg');
    if (frame && frame !== primaryUrl) {
      candidates.push({ transport: 'snapshot', url: frame });
    }
  }

  return candidates;
}

/** Solo i nomi dei trasporti, utile per diagnostica e test. */
export function cameraStartChain(
  rawUrl: string,
  protocol: CameraProtocol,
  hasSnapshot: boolean,
  snapshotUrl?: string,
): CameraTransport[] {
  return cameraCandidates(
    rawUrl,
    protocol,
    hasSnapshot ? (snapshotUrl ?? rawUrl) : undefined,
  ).map((candidate) => candidate.transport);
}

/** Backoff esponenziale limitato: 1s, 2s, 4s, 8s, 15s, 15s… */
export function cameraBackoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt), 15_000);
}

/** Cache-buster per gli endpoint snapshot e per il primo frame MJPEG. */
export function withCacheBuster(rawUrl: string, stamp: number): string {
  const url = normalizeStreamUrl(rawUrl);
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_ts=${stamp}`;
}

/**
 * Attende la raccolta ICE completa: WHEP non negozia trickle ICE, quindi
 * l'offerta deve contenere già i candidati. Il timeout evita di bloccare la
 * card su reti che non completano la raccolta (VLAN isolate, STUN assente).
 */
export function waitForIceGathering(
  peer: RTCPeerConnection,
  timeoutMs = 2_000,
): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    peer.addEventListener('icegatheringstatechange', onChange);
  });
}

/** Esito WHEP normalizzato: URL di sessione per il DELETE e SDP answer. */
export function whepSessionUrl(response: Response, requestUrl: string): string | null {
  const location = response.headers.get('Location');
  if (!location) return null;
  try {
    return new URL(location, requestUrl).toString();
  } catch {
    return null;
  }
}
