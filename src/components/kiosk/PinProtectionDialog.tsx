import { Delete, Lock, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Esito restituito da /api/auth/verify-pin: il client non decide mai il PIN. */
export interface PinVerification {
  ok: boolean;
  locked: boolean;
  retryAfterMs: number;
  remainingAttempts: number;
  lockedUntil: number | null;
}

export interface PinProtectionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  /** 4, 5 o 6 cifre, dalla policy del profilo autenticato. */
  length?: 4 | 5 | 6;
  maxAttempts?: number;
  lockoutMs?: number;
  verify(pin: string): Promise<PinVerification>;
  onSuccess(pin: string): void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(pattern);
  }
}

export function PinProtectionDialog({
  open,
  onOpenChange,
  title,
  description,
  length = 4,
  maxAttempts = 3,
  lockoutMs = 60_000,
  verify,
  onSuccess,
}: PinProtectionDialogProps) {
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const verifyingRef = useRef(false);

  const isLocked = lockedUntil > now;
  const remainingMs = Math.max(0, lockedUntil - now);

  // Il lockout è autorevole sul server; qui si mostra solo il countdown
  // ricevuto, così chiudere e riaprire il dialog non lo azzera.
  useEffect(() => {
    if (lockedUntil === 0) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= lockedUntil) {
        setLockedUntil(0);
        setError(null);
        setRemaining(null);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  useEffect(() => {
    if (!open) {
      setDigits('');
      setError(null);
      setRemaining(null);
      setChecking(false);
      // `lockedUntil` resta: il lockout server-side non svanisce chiudendo il
      // dialog, e il countdown deve riprendere da dove era rimasto.
      verifyingRef.current = false;
    }
  }, [open]);

  const submit = useCallback(
    async (pin: string) => {
      if (verifyingRef.current) return;
      verifyingRef.current = true;
      setChecking(true);
      try {
        const result = await verify(pin);
        if (result.ok) {
          vibrate(30);
          setDigits('');
          setError(null);
          setRemaining(null);
          setLockedUntil(0);
          onSuccess(pin);
          onOpenChange(false);
          return;
        }

        setDigits('');
        vibrate([40, 60, 40]);
        if (result.lockedUntil && result.lockedUntil > Date.now()) {
          setLockedUntil(result.lockedUntil);
          setNow(Date.now());
          setError('Troppi tentativi.');
          setRemaining(0);
        } else {
          setRemaining(result.remainingAttempts);
          setError(
            result.remainingAttempts === 1
              ? 'PIN errato · 1 tentativo rimasto'
              : `PIN errato · ${result.remainingAttempts} tentativi rimasti`,
          );
        }
      } catch {
        // Errori di rete/HTTP: non incrementano i tentativi locali.
        setDigits('');
        setError('Verifica non disponibile. Riprova.');
      } finally {
        setChecking(false);
        verifyingRef.current = false;
      }
    },
    [onOpenChange, onSuccess, verify],
  );

  useEffect(() => {
    if (digits.length === length) {
      void submit(digits);
    }
  }, [digits, length, submit]);

  const pushDigit = (digit: string) => {
    if (isLocked || checking) return;
    if (digits.length >= length) return;
    setError(null);
    setRemaining(null);
    vibrate(8);
    setDigits((current) => `${current}${digit}`);
  };

  const removeDigit = () => {
    if (isLocked || checking) return;
    setError(null);
    setDigits((current) => current.slice(0, -1));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(94vw,24rem)] p-5"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="items-center pt-1 text-center">
          <div
            className={cn(
              'mb-2 flex size-14 items-center justify-center rounded-2xl border',
              isLocked
                ? 'border-danger/30 bg-danger/10 text-danger'
                : 'border-line bg-elevated text-accent',
            )}
          >
            {isLocked ? <ShieldAlert className="size-7" /> : <Lock className="size-6" />}
          </div>
          <DialogTitle className="text-center">{title}</DialogTitle>
          <DialogDescription className="text-center">{description}</DialogDescription>
        </DialogHeader>

        <div className="mt-5 flex justify-center gap-3" aria-label={`PIN di ${length} cifre`}>
          {Array.from({ length }, (_, index) => {
            const filled = index < digits.length;
            return (
              <span
                key={index}
                className={cn(
                  'size-3.5 rounded-full border transition-all duration-150',
                  filled
                    ? 'scale-110 border-accent bg-accent'
                    : 'border-line-strong bg-transparent',
                  error && 'border-danger/60',
                )}
              />
            );
          })}
        </div>

        <div className="h-6 pt-1 text-center">
          <p
            className={cn(
              'text-xs font-medium',
              error || isLocked ? 'text-danger' : 'text-fg-subtle',
              error && !isLocked && 'animate-shake',
            )}
            role="status"
            aria-live="polite"
          >
            {isLocked
              ? `Bloccato · ${Math.ceil(remainingMs / 1000)}s`
              : (error ?? (checking ? 'Verifica sul gateway…' : `Inserisci il PIN di ${length} cifre`))}
          </p>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => pushDigit(key)}
              disabled={isLocked || checking}
              className={cn(
                'flex h-14 items-center justify-center rounded-2xl border border-line bg-panel-2',
                'text-xl font-medium tabular text-fg transition-colors',
                'hover:border-line-strong hover:bg-elevated active:scale-[0.97] active:bg-elevated',
                'disabled:opacity-30',
              )}
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setDigits('');
              setError(null);
            }}
            disabled={isLocked || checking || digits.length === 0}
            className="flex h-14 items-center justify-center rounded-2xl text-xs font-medium uppercase tracking-wide text-fg-subtle transition-colors hover:text-fg disabled:opacity-30"
            aria-label="Cancella tutto"
          >
            C
          </button>
          <button
            type="button"
            onClick={() => pushDigit('0')}
            disabled={isLocked || checking}
            className="flex h-14 items-center justify-center rounded-2xl border border-line bg-panel-2 text-xl font-medium tabular text-fg transition-colors hover:border-line-strong hover:bg-elevated active:scale-[0.97] disabled:opacity-30"
          >
            0
          </button>
          <button
            type="button"
            onClick={removeDigit}
            disabled={isLocked || checking || digits.length === 0}
            className="flex h-14 items-center justify-center rounded-2xl text-fg-subtle transition-colors hover:text-fg disabled:opacity-30"
            aria-label="Cancella ultima cifra"
          >
            <Delete className="size-5" />
          </button>
        </div>

        <p className="mt-4 text-center text-[10px] leading-relaxed text-fg-subtle">
          Verifica sul gateway · {maxAttempts} tentativi, blocco temporaneo di{' '}
          {Math.round(lockoutMs / 1000)}s
          {remaining !== null && remaining > 0 && !isLocked
            ? ` · ${remaining} rimasti`
            : ''}
        </p>
      </DialogContent>
    </Dialog>
  );
}
