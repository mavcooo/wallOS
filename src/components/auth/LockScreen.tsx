import { House, KeyRound, Loader2, ShieldCheck, TabletSmartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/lib/utils';

type Mode = 'kiosk' | 'account';

const DEFAULT_DEVICE_ID = import.meta.env.VITE_KIOSK_DEVICE_ID?.trim() || 'wall-panel-1';

export function LockScreen() {
  const loginKiosk = useAuthStore((state) => state.loginKiosk);
  const login = useAuthStore((state) => state.login);
  const clearError = useAuthStore((state) => state.clearError);
  const error = useAuthStore((state) => state.error);

  const [mode, setMode] = useState<Mode>('kiosk');
  const [deviceId, setDeviceId] = useState(DEFAULT_DEVICE_ID);
  const [pin, setPin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setPin('');
    setPassword('');
    clearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    if (mode === 'kiosk') {
      await loginKiosk(deviceId.trim(), pin);
    } else {
      await login(username.trim(), password);
    }
    setBusy(false);
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft text-accent">
            <House className="size-6" strokeWidth={2.2} />
          </div>
          <h1 className="mt-3 text-lg font-semibold tracking-[0.18em] text-fg">DOMUS</h1>
          <p className="mt-1 text-[11px] uppercase tracking-wider text-fg-subtle">
            Local control · accesso protetto
          </p>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-panel p-5">
          <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-line bg-panel-2 p-1">
            <button
              type="button"
              onClick={() => switchMode('kiosk')}
              aria-pressed={mode === 'kiosk'}
              className={cn(
                'flex h-10 items-center justify-center gap-2 rounded-lg text-[11px] font-medium transition-colors',
                mode === 'kiosk' ? 'bg-elevated text-fg' : 'text-fg-subtle hover:text-fg',
              )}
            >
              <TabletSmartphone className="size-3.5" /> Kiosk
            </button>
            <button
              type="button"
              onClick={() => switchMode('account')}
              aria-pressed={mode === 'account'}
              className={cn(
                'flex h-10 items-center justify-center gap-2 rounded-lg text-[11px] font-medium transition-colors',
                mode === 'account' ? 'bg-elevated text-fg' : 'text-fg-subtle hover:text-fg',
              )}
            >
              <KeyRound className="size-3.5" /> Account
            </button>
          </div>

          <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
            {mode === 'kiosk' ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kiosk-device">Identificativo dispositivo</Label>
                  <Input
                    id="kiosk-device"
                    value={deviceId}
                    onChange={(event) => setDeviceId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kiosk-pin">PIN dispositivo</Label>
                  <Input
                    id="kiosk-pin"
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={pin}
                    onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                    autoComplete="off"
                    className="h-12 text-center text-lg tracking-[0.4em]"
                    placeholder="••••"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="auth-username">Username</Label>
                  <Input
                    id="auth-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    spellCheck={false}
                    className="h-11"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="auth-password">Password</Label>
                  <Input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className="h-11"
                  />
                </div>
              </>
            )}

            <div className="min-h-5 text-center">
              {error ? (
                <p className="text-[11px] font-medium text-danger" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <Button
              type="submit"
              variant="primary"
              className="h-11 w-full"
              disabled={busy || (mode === 'kiosk' ? pin.length < 4 : !username || !password)}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? 'Verifica…' : mode === 'kiosk' ? 'Sblocca pannello' : 'Accedi'}
            </Button>
          </form>
        </div>

        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
          <span className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
            Credenziali e PIN sono verificati dal gateway locale. Il browser riceve solo un
            token HttpOnly e il profilo sanitizzato.
          </span>
          <span>
            Il PIN del dispositivo viene richiesto una sola volta: la sessione kiosk resta
            valida 90 giorni, anche dopo un riavvio del tablet.
          </span>
        </div>
      </div>
    </div>
  );
}
