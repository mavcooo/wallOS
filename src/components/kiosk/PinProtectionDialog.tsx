import { Delete, Lock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import {
  clearPinRateLimit,
  EMPTY_PIN_RATE_LIMIT_STATE,
  loadPinRateLimit,
  normalizeExpiredLockout,
  normalizePinRateLimitConfig,
  savePinRateLimit,
  verifyPinAttempt,
  type PinAttemptResponse,
  type PinRateLimitState,
} from '@/lib/pin';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Esito restituito da /api/auth/verify-pin: il client non decide mai il PIN. */
export type PinVerification = PinAttemptResponse;

export interface PinProtectionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  /** 4, 5 o 6 cifre, dalla policy del profilo autenticato. */
  length?: 4 | 5 | 6;
  /**
   * Tentativi consentiti prima del blocco locale (limitato a 3–5). PinProvider
   * passa la policy del gateway, che resta il limite autorevole.
   */
  maxAttempts?: number;
  /** Durata del primo blocco locale; raddoppia a ogni blocco successivo. */
  lockoutDurationSeconds?: number;
  /** Tetto del backoff progressivo. */
  maxLockoutDurationSeconds?: number;
  /** Profilo proprietario del PIN: isola i contatori persistiti. */
  scope?: string;
  verify(pin: string): Promise<PinAttemptResponse>;
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
  maxAttempts,
  lockoutDurationSeconds,
  maxLockoutDurationSeconds,
  scope = 'default',
  verify,
  onSuccess,
}: PinProtectionDialogProps) {
  const { t } = useTranslation('auth');
  const rateConfig = useMemo(
    () =>
      normalizePinRateLimitConfig({
        maxAttempts,
        lockoutDurationSeconds,
        maxLockoutDurationSeconds,
      }),
    [maxAttempts, lockoutDurationSeconds, maxLockoutDurationSeconds],
  );

  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [rate, setRate] = useState<PinRateLimitState>({ ...EMPTY_PIN_RATE_LIMIT_STATE });
  const [now, setNow] = useState(Date.now());
  const [shakeId, setShakeId] = useState(0);
  const verifyingRef = useRef(false);

  const isLocked = rate.lockoutUntil > now;
  const lockoutSeconds = isLocked ? Math.max(1, Math.ceil((rate.lockoutUntil - now) / 1000)) : 0;

  // Al riaprirsi del dialog (o al cambio profilo) si rilegge il blocco
  // persistito: chiudere il pannello o ricaricare la pagina non lo azzera.
  useEffect(() => {
    if (!open) return;
    const persisted = loadPinRateLimit(scope, rateConfig);
    setRate(persisted);
    setNow(Date.now());
    setDigits('');
    setError(null);
    setRemaining(null);
    setChecking(false);
    setShakeId(0);
    verifyingRef.current = false;
  }, [open, scope, rateConfig]);

  useEffect(() => {
    if (!open) {
      setDigits('');
      setError(null);
      setRemaining(null);
      setChecking(false);
      verifyingRef.current = false;
    }
  }, [open]);

  // Countdown del blocco: al raggiungimento dello zero il tastierino si
  // riabilita da solo, senza interazioni manuali.
  useEffect(() => {
    if (rate.lockoutUntil <= 0) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= rate.lockoutUntil) {
        const normalized = normalizeExpiredLockout(rate, current);
        setRate(normalized);
        savePinRateLimit(scope, normalized);
        setError(null);
        setRemaining(null);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [rate, scope]);

  const submit = useCallback(
    async (pin: string) => {
      if (verifyingRef.current || Date.now() < rate.lockoutUntil) return;
      verifyingRef.current = true;
      setChecking(true);
      try {
        const { result, state: next } = await verifyPinAttempt(
          pin,
          verify,
          rate,
          rateConfig,
        );

        if (result.success) {
          clearPinRateLimit(scope);
          setRate({ ...EMPTY_PIN_RATE_LIMIT_STATE });
          vibrate(30);
          setDigits('');
          setError(null);
          setRemaining(null);
          onSuccess(pin);
          onOpenChange(false);
          return;
        }

        savePinRateLimit(scope, next);
        setRate(next);
        setNow(Date.now());
        setDigits('');
        setShakeId((id) => id + 1);
        vibrate([40, 60, 40]);

        if (result.isLocked) {
          setRemaining(0);
          setError(null);
          return;
        }

        setRemaining(result.remainingAttempts);
        setError(t('pinDialog.wrongPin', { count: result.remainingAttempts }));
      } catch {
        // Errori di rete/HTTP: non incrementano i tentativi locali.
        setDigits('');
        setError(t('pinDialog.verifyUnavailable'));
      } finally {
        setChecking(false);
        verifyingRef.current = false;
      }
    },
    [onOpenChange, onSuccess, rate, rateConfig, scope, t, verify],
  );

  useEffect(() => {
    if (digits.length === length) {
      void submit(digits);
    }
  }, [digits, length, submit]);

  const pushDigit = useCallback(
    (digit: string) => {
      if (checking || Date.now() < rate.lockoutUntil) return;
      setError(null);
      setRemaining(null);
      vibrate(8);
      setDigits((current) => (current.length >= length ? current : `${current}${digit}`));
    },
    [checking, length, rate.lockoutUntil],
  );

  const removeDigit = useCallback(() => {
    if (checking || Date.now() < rate.lockoutUntil) return;
    setError(null);
    setDigits((current) => current.slice(0, -1));
  }, [checking, rate.lockoutUntil]);

  const clearDigits = useCallback(() => {
    if (checking || Date.now() < rate.lockoutUntil) return;
    setDigits('');
    setError(null);
    setRemaining(null);
  }, [checking, rate.lockoutUntil]);

  // Tastiera fisica: durante il blocco i tasti numerici e Backspace vengono
  // intercettati e ignorati, come i pulsanti touch disabilitati.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const digit = /^[0-9]$/.test(event.key) ? event.key : null;
      const editing = event.key === 'Backspace' || event.key === 'Delete';
      if (digit === null && !editing) return;
      event.preventDefault();
      if (isLocked || checking) return;
      if (digit !== null) pushDigit(digit);
      else removeDigit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isLocked, checking, pushDigit, removeDigit]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(94vw,24rem)] p-5"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="items-center pt-1 text-center">
          <div
            className={cn(
              'relative mb-2 flex size-14 items-center justify-center rounded-2xl border',
              isLocked
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-line bg-elevated text-accent',
            )}
          >
            <Lock className="size-6" aria-hidden="true" />
            {isLocked ? (
              <span
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-bg bg-danger text-[11px] font-bold text-bg"
                aria-hidden="true"
              >
                !
              </span>
            ) : null}
          </div>
          <DialogTitle className="text-center">{title}</DialogTitle>
          <DialogDescription className="text-center">{description}</DialogDescription>
        </DialogHeader>

        <div
          key={shakeId}
          className={cn(
            'mt-5 flex justify-center gap-3',
            shakeId > 0 && 'animate-shake motion-reduce:animate-none',
          )}
          aria-label={t('pinDialog.digitsAria', { length })}
        >
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
                  (error || isLocked) && 'border-danger/60',
                )}
              />
            );
          })}
        </div>

        <div className="mt-3 min-h-12 px-1 text-center">
          {isLocked ? (
            <div
              className="animate-fade-in rounded-xl border border-danger/30 bg-danger/10 px-3 py-2"
              role="alert"
              aria-live="assertive"
            >
              <p className="text-xs font-semibold text-danger">{t('pinDialog.lockedTitle')}</p>
              <p className="mt-0.5 text-[11px] tabular text-danger/90">
                {t('pinDialog.lockedCountdown', { seconds: lockoutSeconds })}
              </p>
            </div>
          ) : (
            <p
              className={cn(
                'pt-1 text-xs font-medium',
                error ? 'text-danger' : 'text-fg-subtle',
              )}
              role="status"
              aria-live="polite"
            >
              {error ??
                (checking
                  ? t('pinDialog.checking')
                  : t('pinDialog.prompt', { length }))}
            </p>
          )}
        </div>

        <div className="mt-1 grid grid-cols-3 gap-2">
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
                'disabled:cursor-not-allowed disabled:opacity-30',
              )}
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={clearDigits}
            disabled={isLocked || checking || digits.length === 0}
            className="flex h-14 items-center justify-center rounded-2xl text-xs font-medium uppercase tracking-wide text-fg-subtle transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
            aria-label={t('pinDialog.clearAll')}
          >
            C
          </button>
          <button
            type="button"
            onClick={() => pushDigit('0')}
            disabled={isLocked || checking}
            className="flex h-14 items-center justify-center rounded-2xl border border-line bg-panel-2 text-xl font-medium tabular text-fg transition-colors hover:border-line-strong hover:bg-elevated active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30"
          >
            0
          </button>
          <button
            type="button"
            onClick={removeDigit}
            disabled={isLocked || checking || digits.length === 0}
            className="flex h-14 items-center justify-center rounded-2xl text-fg-subtle transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
            aria-label={t('pinDialog.clearLast')}
          >
            <Delete className="size-5" />
          </button>
        </div>

        <p className="mt-4 text-center text-[10px] leading-relaxed text-fg-subtle">
          {t('pinDialog.footer', { count: rateConfig.maxAttempts })}
          {remaining !== null && remaining > 0 && !isLocked
            ? t('pinDialog.remaining', { count: remaining })
            : ''}
        </p>
      </DialogContent>
    </Dialog>
  );
}
