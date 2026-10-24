import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PinProvider } from '@/components/kiosk/PinProvider';
import { AppShell } from '@/components/layout/AppShell';
import { usePixelShift } from '@/hooks/usePixelShift';
import { useAuthStore } from '@/store/authStore';
import { useHomeStore } from '@/store/homeStore';
import { SEED_TOPOLOGY } from '@/test/fixtures';
import { renderWithTopology } from '@/test/query';
import type { BurnInMode } from '@/types/kiosk';

/**
 * Regressione anti-reflow.
 *
 * jsdom non ha un motore di layout, quindi non può misurare il tempo di
 * layout reale: qui la garanzia viene misurata su ciò che *causa* un reflow.
 * 1. le uniche proprietà CSS mai scritte sono `transform`, `transition` e
 *    `will-change` (mai top/left/width/height/margin);
 * 2. le letture di layout (`getBoundingClientRect`) sono limitate a una per
 *    spostamento nel modo float e a zero nel micro-shift;
 * 3. il costo JS per spostamento resta basso (proxy del lavoro per tick).
 * Il tempo di paint vero va misurato in un browser, non qui.
 */

const MOVES = 120;
const INTERVAL_MS = 1_000;
const ALLOWED_STYLE_PROPS = new Set(['transform', 'transition', 'will-change']);

function styleMap(value: string | null): Map<string, string> {
  const element = document.createElement('div');
  if (value) element.setAttribute('style', value);
  const map = new Map<string, string>();
  for (let index = 0; index < element.style.length; index += 1) {
    const name = element.style.item(index);
    map.set(name, element.style.getPropertyValue(name));
  }
  return map;
}

/** Proprietà CSS cambiate fra due snapshot della dichiarazione inline. */
function changedProps(before: string | null, after: string | null): string[] {
  const from = styleMap(before);
  const to = styleMap(after);
  const names = new Set([...from.keys(), ...to.keys()]);
  return [...names].filter((name) => from.get(name) !== to.get(name));
}

/**
 * Raccoglie gli `style` precedenti di ogni mutazione: leggere l'attributo nel
 * callback darebbe solo il valore finale, gli oldValue invece restano in ordine.
 */
function watchStyle(target: Element) {
  const oldValues: (string | null)[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) oldValues.push(record.oldValue);
  });
  observer.observe(target, {
    attributes: true,
    attributeFilter: ['style'],
    attributeOldValue: true,
  });

  return {
    /** Elenca le proprietà cambiate in ogni commit osservato. */
    commitChanges(): string[][] {
      const records = observer.takeRecords();
      for (const record of records) oldValues.push(record.oldValue);

      const snapshots = [...oldValues, target.getAttribute('style')];
      const changes: string[][] = [];
      for (let index = 0; index < snapshots.length - 1; index += 1) {
        const props = changedProps(snapshots[index] ?? null, snapshots[index + 1] ?? null);
        if (props.length > 0) changes.push(props);
      }
      return changes;
    },
    disconnect: () => observer.disconnect(),
  };
}

function Probe({ mode }: { mode: BurnInMode }) {
  const ref = useRef<HTMLDivElement>(null);
  const shift = usePixelShift({ mode, intervalMs: INTERVAL_MS, targetRef: ref });
  return <div ref={ref} data-testid="probe" style={shift.style} />;
}

async function advanceMoves(moves = MOVES) {
  await act(async () => {
    for (let index = 0; index < moves; index += 1) {
      vi.advanceTimersByTime(INTERVAL_MS);
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  // `process.hrtime` resta reale: serve a misurare il costo JS per spostamento.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePixelShift · assenza di reflow', () => {
  it('il micro-shift scrive solo transform e non legge il layout', async () => {
    render(<Probe mode="subtle-shift" />);
    const element = screen.getByTestId('probe');
    const watcher = watchStyle(element);

    const rectReads = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    rectReads.mockClear();

    await advanceMoves();

    const changes = watcher.commitChanges();
    expect(changes.length).toBeGreaterThan(0);
    for (const props of changes) {
      for (const prop of props) expect(ALLOWED_STYLE_PROPS.has(prop)).toBe(true);
    }

    // Nessuna misura del bounding box: il micro-shift non può forzare layout.
    expect(rectReads).not.toHaveBeenCalled();
    expect(element.style.transform).toMatch(/^translate3d\(-?[\d.]+px, -?[\d.]+px, 0\)$/);

    watcher.disconnect();
  });

  it('il float legge il layout al massimo una volta per spostamento', async () => {
    render(<Probe mode="screensaver-float" />);
    const element = screen.getByTestId('probe');
    const watcher = watchStyle(element);

    const rectReads = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    rectReads.mockClear();

    await advanceMoves();

    const changes = watcher.commitChanges();
    for (const props of changes) {
      for (const prop of props) expect(ALLOWED_STYLE_PROPS.has(prop)).toBe(true);
    }

    // Una sola misura per move: niente letture dentro l'animazione o per frame.
    expect(rectReads.mock.calls.length).toBeLessThanOrEqual(MOVES);
    expect(rectReads.mock.calls.length).toBeGreaterThan(MOVES / 2);

    watcher.disconnect();
  });

  it('il costo JS per spostamento resta basso e lineare', async () => {
    render(<Probe mode="screensaver-float" />);
    const element = screen.getByTestId('probe');

    const seen = new Set<string>();
    const started = process.hrtime.bigint();

    // Un `act` per move: il commit di React avviene alla chiusura, quindi
    // leggere il transform dentro un unico act vedrebbe sempre il primo valore.
    for (let index = 0; index < MOVES; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        vi.advanceTimersByTime(INTERVAL_MS);
        await Promise.resolve();
      });
      seen.add(element.style.transform);
    }

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const perMove = elapsedMs / MOVES;

    expect(seen.size).toBeGreaterThan(MOVES / 2);
    // Soglia larga: intercetta loop patologici, non micro-ottimizzazioni.
    expect(perMove).toBeLessThan(5);
  });

  it('l’AppShell sposta il contenuto solo con transform', async () => {
    useHomeStore.getState().setBurnInSettings({ shiftIntervalMs: 1_000 });
    // L'AppShell vive sotto AuthGate in produzione: qui la sessione è simulata
    // per isolare il comportamento di pixel-shift.
    useAuthStore.setState({
      status: 'authenticated',
      user: {
        id: 'user-test',
        username: 'test',
        name: 'Test Kiosk',
        initials: 'TK',
        role: 'admin',
        allowedRooms: null,
        active: true,
        isKioskDevice: false,
        kioskDeviceId: null,
        lastAccess: null,
        pinLength: 4,
      },
      elevated: false,
    });
    // L'header legge le stanze da TanStack Query: serve la cache popolata.
    renderWithTopology(
      <PinProvider>
        <AppShell>
          <div>contenuto</div>
        </AppShell>
      </PinProvider>,
      { topology: SEED_TOPOLOGY },
    );

    const shifted = document.querySelector<HTMLElement>('[style*="translate3d"]');
    expect(shifted).not.toBeNull();
    if (!shifted) throw new Error('wrapper traslato non trovato');

    const watcher = watchStyle(shifted);

    await advanceMoves(30);

    const changes = watcher.commitChanges();
    expect(changes.length).toBeGreaterThan(0);
    for (const props of changes) {
      for (const prop of props) expect(ALLOWED_STYLE_PROPS.has(prop)).toBe(true);
    }
    expect(shifted.style.top).toBe('');
    expect(shifted.style.left).toBe('');

    watcher.disconnect();
  });
});
