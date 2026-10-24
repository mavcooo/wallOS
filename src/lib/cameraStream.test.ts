import { describe, expect, it } from 'vitest';

import {
  cameraBackoffMs,
  cameraCandidates,
  cameraStartChain,
  go2rtcVariant,
  inferCameraTransport,
  normalizeStreamUrl,
  whepSessionUrl,
  withCacheBuster,
} from '@/lib/cameraStream';

describe('cameraStream · scelta del trasporto', () => {
  it('converte lo schema webrtc:// nell’endpoint HTTP usato dal browser', () => {
    expect(normalizeStreamUrl('webrtc://192.168.0.59:1984/api/webrtc?src=gate')).toBe(
      'http://192.168.0.59:1984/api/webrtc?src=gate',
    );
    expect(normalizeStreamUrl(' https://proxy.local/live.m3u8 ')).toBe(
      'https://proxy.local/live.m3u8',
    );
  });

  it('deduce HLS e MJPEG dall’estensione quando il protocollo è auto', () => {
    expect(inferCameraTransport('http://proxy/live.m3u8?token=1', 'auto')).toBe('hls');
    expect(inferCameraTransport('http://proxy/video.mjpeg', 'auto')).toBe('mjpeg');
    expect(inferCameraTransport('http://proxy/api/webrtc?src=gate', 'auto')).toBe('webrtc');
  });

  it('rispetta il protocollo esplicito', () => {
    expect(inferCameraTransport('http://proxy/live.m3u8', 'webrtc')).toBe('webrtc');
    expect(inferCameraTransport('http://proxy/api/webrtc', 'mjpeg')).toBe('mjpeg');
  });

  it('aggiunge lo snapshot solo quando esiste un fallback configurato', () => {
    expect(cameraStartChain('http://proxy/live.m3u8', 'auto', true)).toEqual([
      'hls',
      'snapshot',
    ]);
    expect(cameraStartChain('http://proxy/live.m3u8', 'auto', false)).toEqual(['hls']);
    expect(cameraStartChain('http://proxy/live', 'webrtc', true)).toEqual([
      'webrtc',
      'snapshot',
    ]);
  });

  it('deriva HLS e snapshot dagli endpoint go2rtc mantenendo la query', () => {
    expect(go2rtcVariant('http://192.168.0.59:1984/api/webrtc?src=gate', 'stream.m3u8')).toBe(
      'http://192.168.0.59:1984/api/stream.m3u8?src=gate',
    );
    expect(go2rtcVariant('http://192.168.0.59:1984/api/webrtc?src=gate', 'frame.jpeg')).toBe(
      'http://192.168.0.59:1984/api/frame.jpeg?src=gate',
    );
    expect(go2rtcVariant('http://proxy.local/live', 'frame.jpeg')).toBeNull();

    const candidates = cameraCandidates(
      'http://192.168.0.59:1984/api/webrtc?src=gate',
      'auto',
    );
    expect(candidates.map((candidate) => candidate.transport)).toEqual([
      'webrtc',
      'hls',
      'snapshot',
    ]);
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      'http://192.168.0.59:1984/api/webrtc?src=gate',
      'http://192.168.0.59:1984/api/stream.m3u8?src=gate',
      'http://192.168.0.59:1984/api/frame.jpeg?src=gate',
    ]);
  });
});

describe('cameraStream · resilienza', () => {
  it('applica un backoff esponenziale con tetto a 15 secondi', () => {
    expect([0, 1, 2, 3, 4, 8].map(cameraBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
    ]);
  });

  it('aggiunge il cache-buster preservando la query esistente', () => {
    expect(withCacheBuster('http://proxy/frame.jpeg?src=gate', 123)).toBe(
      'http://proxy/frame.jpeg?src=gate&_ts=123',
    );
    expect(withCacheBuster('http://proxy/frame.jpeg', 123)).toBe(
      'http://proxy/frame.jpeg?_ts=123',
    );
  });

  it('risolve il Location WHEP relativo sulla richiesta originale', () => {
    const response = new Response('answer', {
      status: 200,
      headers: { Location: '/api/webrtc/session/42' },
    });
    expect(whepSessionUrl(response, 'http://proxy.local:1984/api/webrtc?src=gate')).toBe(
      'http://proxy.local:1984/api/webrtc/session/42',
    );

    const noLocation = new Response('answer', { status: 200 });
    expect(whepSessionUrl(noLocation, 'http://proxy.local/api/webrtc')).toBeNull();
  });
});
