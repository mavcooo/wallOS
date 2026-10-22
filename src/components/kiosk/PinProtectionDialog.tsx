import { Delete, Lock, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PIN_RULES } from '@/config/app.config';
import { useHomeStore } from '@/store/homeStore';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface PinProtectionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  /** 4 o 6 cifre (ereditato dal PIN configurato). */
  length?: 4 | 6;
  verify(pin: string): Promise<boolean>;
  onSuccess(): void;
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
  verify,
  onSuccess,
}: PinProtectionDialogProps) {
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const verifyingRef = useRef(false);

  const attempts = useHomeStore((state) => state.pinAttempts);
  const lockedUntil = useHomeStore((state) => state.pinLockedUntil);
  const registerPinFailure = useHomeStore((state) => state.registerPinFailure);
  const resetPinFailures = useHomeStore((state) => state.resetPinFailures);

  const isLocked = lockedUntil > now;
  const remainingMs = Math.max(0, lockedUntil - now);

  // Countdown + sblocco automatico: i tentativi restano nello store, quindi
  // chiudere e riaprire il dialog non azzera il blocco.
  useEffect(() => {
    if (lockedUntil === 0) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= lockedUntil) {
        resetPinFailures();
        setError(null);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [lockedUntil, resetPinFailures]);

  useEffect(() => {
    if (!open) {
      setDigits('');
      setError(null);
      setChecking(false);
      verifyingRef.current = false;
    }
  }, [open]);

  const submit = useCallback(
    async (pin: string) => {
      if (verifyingRef.current) return;
      verifyingRef.current = true;
      setChecking(true);
      const valid = await verify(pin);
      setChecking(false);
      verifyingRef.current = false;
      if (valid) {
        vibrate(30);
        setDigits('');
        setError(null);
        resetPinFailures();
        onSuccess();
        onOpenChange(false);
        return;
      }
      const result = registerPinFailure();
      setDigits('');
      vibrate([40, 60, 40]);
      if (result.attempts >= PIN_RULES.maxAttempts) {
        setError(`Troppi tentativi. Riprova tra ${Math.ceil(PIN_RULES.lockoutMs / 1000)}s.`);
      } else {
        const remaining = PIN_RULES.maxAttempts - result.attempts;
        setError(`PIN errato · ${remaining} ${remaining === 1 ? 'tentativo' : 'tentativi'} rimasti`);
      }
    },
    [onOpenChange, onSuccess, registerPinFailure, resetPinFailures, verify],
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
              : (error ?? (checking ? 'Verifica…' : `Inserisci il PIN di ${length} cifre`))}
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
          Azione protetta · {PIN_RULES.maxAttempts} tentativi, blocco temporaneo di{' '}
          {PIN_RULES.lockoutMs / 1000}s
          {attempts > 0 && !isLocked ? ` · ${attempts} falliti` : ''}
        </p>
      </DialogContent>
    </Dialog>
  );
}
