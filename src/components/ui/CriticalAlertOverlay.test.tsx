import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PinProvider } from '@/components/kiosk/PinProvider';
import { CriticalAlertOverlay } from '@/components/ui/CriticalAlertOverlay';
import { useToastStore } from '@/store/toastStore';

const audio = vi.hoisted(() => ({
  playAlarm: vi.fn(),
  stopAlarm: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock('@/utils/audioAlert', () => ({
  audioAlert: audio,
  bindAudioUnlockOnFirstGesture: vi.fn(),
}));

beforeEach(() => {
  useToastStore.setState({ toasts: [], history: [], alarmSilenced: false });
  audio.playAlarm.mockClear();
  audio.stopAlarm.mockClear();
});

function renderOverlay() {
  return render(
    <PinProvider>
      <CriticalAlertOverlay />
    </PinProvider>,
  );
}

describe('CriticalAlertOverlay', () => {
  it('mostra il primo allarme, gli altri e avvia la sirena', () => {
    const { addCritical } = useToastStore.getState();
    addCritical({
      title: 'Fumo in cucina',
      description: 'Cucina · Sensore fumo',
      metadata: { type: 'smoke' },
    });
    addCritical({ title: 'Perdita in bagno', metadata: { type: 'flood' } });

    renderOverlay();

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fumo in cucina' })).toBeInTheDocument();
    expect(screen.getByText('1 altro allarme attivo')).toBeInTheDocument();
    expect(audio.playAlarm).toHaveBeenCalledWith('siren');
  });

  it('"Tacita segnale sonoro" ferma l’audio senza chiudere l’allarme', () => {
    useToastStore.getState().addCritical({ title: 'Fumo in cucina', metadata: { type: 'smoke' } });
    renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: 'Tacita segnale sonoro' }));

    expect(useToastStore.getState().alarmSilenced).toBe(true);
    expect(audio.stopAlarm).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Fumo in cucina' })).toBeInTheDocument();
  });

  it('"Riconosci e chiudi" rimuove l’allarme e lo archivia', () => {
    const id = useToastStore
      .getState()
      .addCritical({ title: 'Fumo in cucina', metadata: { type: 'smoke' } });
    renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: 'Riconosci e chiudi' }));

    const state = useToastStore.getState();
    expect(state.toasts).toHaveLength(0);
    expect(state.history[0]?.id).toBe(id);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
