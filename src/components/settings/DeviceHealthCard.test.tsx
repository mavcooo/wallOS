import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceHealthCard } from '@/components/settings/DeviceHealthCard';
import { useDeviceHealthStore } from '@/store/deviceHealthStore';
import { useHomeStore } from '@/store/homeStore';
import { setKioskId } from '@/utils/kioskIdentity';

const MEGABYTE = 1024 * 1024;

function seedHealth(overrides: Partial<ReturnType<typeof useDeviceHealthStore.getState>> = {}) {
  useDeviceHealthStore.setState({
    supported: true,
    level: 42,
    charging: false,
    chargingTimeSec: 0,
    heap: {
      usedBytes: 48 * MEGABYTE,
      totalBytes: 60 * MEGABYTE,
      limitBytes: 120 * MEGABYTE,
    },
    heapRatio: 0.4,
    fps: 58,
    sampledAt: Date.now(),
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  setKioskId('tablet_ingresso');
  seedHealth();
  useHomeStore.getState().patchConnection({ latencyMs: 12, status: 'connected' });
});

afterEach(() => {
  useHomeStore.getState().patchConnection({ latencyMs: null, status: 'idle' });
});

describe('DeviceHealthCard · batteria', () => {
  it('mostra la percentuale con la barra nella fascia di protezione', () => {
    render(<DeviceHealthCard />);

    expect(screen.getByTestId('battery-level')).toHaveTextContent('42%');
    expect(screen.getByTestId('battery-level')).toHaveAttribute('data-band', 'ok');
    expect(screen.getByTestId('battery-bar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByTestId('battery-bar')).toHaveAttribute('data-band', 'ok');
    expect(screen.getByTestId('battery-state')).toHaveTextContent('A batteria');
    expect(screen.getByText('In fascia di protezione 20-80%')).toBeInTheDocument();
  });

  it('colora fuori banda quando la carica scende sotto il 20%', () => {
    seedHealth({ level: 8 });

    render(<DeviceHealthCard />);

    expect(screen.getByTestId('battery-level')).toHaveAttribute('data-band', 'low');
    expect(screen.getByTestId('battery-bar')).toHaveAttribute('data-band', 'low');
    expect(screen.getByText('Sotto il 20%: l’alimentatore resta attivo')).toBeInTheDocument();
  });

  it('segnala il caso in cui l’alimentatore va staccato', () => {
    seedHealth({ level: 92, charging: true, chargingTimeSec: 900 });

    render(<DeviceHealthCard />);

    expect(screen.getByTestId('battery-level')).toHaveAttribute('data-band', 'high');
    expect(screen.getByTestId('battery-state')).toHaveTextContent('In carica');
    expect(screen.getByText('Completa in ~15 min')).toBeInTheDocument();
  });

  it('dichiara il degrado dove la Battery API non esiste', () => {
    useDeviceHealthStore.setState({
      supported: false,
      level: 0,
      charging: false,
      chargingTimeSec: 0,
      heap: null,
      heapRatio: null,
      fps: null,
      sampledAt: null,
    });

    render(<DeviceHealthCard />);

    expect(screen.getByTestId('battery-api-badge')).toHaveTextContent('Battery API non disponibile');
    expect(screen.getByTestId('battery-level')).toHaveTextContent('n/d');
    expect(screen.getByTestId('battery-level')).toHaveAttribute('data-band', 'unsupported');
    expect(screen.getByTestId('battery-state')).toHaveTextContent('Battery Status API');
  });
});

describe('DeviceHealthCard · memoria, rete e fluidità', () => {
  it('mostra heap usato su limite, latenza del broker e frame rate', () => {
    render(<DeviceHealthCard />);

    expect(screen.getByTestId('heap-usage')).toHaveTextContent('48 MB / 120 MB');
    expect(screen.getByTestId('heap-usage')).toHaveAttribute('data-band', 'ok');
    expect(screen.getByTestId('health-latency')).toHaveTextContent('12 ms');
    expect(screen.getByTestId('health-fps')).toHaveTextContent('58 fps');
    expect(screen.getByTestId('battery-api-badge')).toHaveTextContent('Battery API nativa');
  });

  it('marca l’heap oltre l’85% del limite', () => {
    seedHealth({
      heap: { usedBytes: 108 * MEGABYTE, totalBytes: 110 * MEGABYTE, limitBytes: 120 * MEGABYTE },
      heapRatio: 0.9,
    });

    render(<DeviceHealthCard />);

    expect(screen.getByTestId('heap-usage')).toHaveAttribute('data-band', 'warn');
    expect(screen.getByTestId('heap-bar')).toHaveAttribute('data-band', 'warn');
  });

  it('scrive n/d dove il browser non espone i dati', () => {
    seedHealth({ heap: null, heapRatio: null, fps: null });
    useHomeStore.getState().patchConnection({ latencyMs: null });

    render(<DeviceHealthCard />);

    expect(screen.getByTestId('heap-usage')).toHaveTextContent('n/d');
    expect(screen.getByTestId('heap-usage')).toHaveAttribute('data-band', 'unsupported');
    expect(screen.getByTestId('health-latency')).toHaveTextContent('— ms');
    expect(screen.getByTestId('health-fps')).toHaveTextContent('n/d');
  });

  it('documenta il topic pubblicato verso la presa smart', () => {
    render(<DeviceHealthCard />);

    expect(screen.getByTestId('health-telemetry-note')).toHaveTextContent(
      'wallos/kiosk/tablet_ingresso/battery',
    );
    expect(screen.getByTestId('health-telemetry-note')).toHaveTextContent('ogni 60 s');
  });
});
