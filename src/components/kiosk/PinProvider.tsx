import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useAuthStore } from '@/store/authStore';
import { PinProtectionDialog } from './PinProtectionDialog';

export interface PinRequest {
  title: string;
  description: string;
  /** Etichetta dell'azione mostrata nella descrizione. */
  action?: string;
  length?: 4 | 5 | 6;
  /**
   * Eseguita solo dopo la verifica server. Riceve il PIN appena validato,
   * necessario alle API che richiedono una conferma esplicita (cambio profilo).
   */
  onConfirm(pin?: string): void;
}

type RequestPin = (request: PinRequest) => void;

const PinGuardContext = createContext<RequestPin | null>(null);

/**
 * Un solo dialog per tutta l'app: qualunque azione sensibile chiama
 * `usePinGuard()({ ... })` e viene eseguita solo dopo la verifica.
 */
export function PinProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PinRequest | null>(null);
  const verifyPin = useAuthStore((state) => state.verifyPin);
  const pinPolicy = useAuthStore((state) => state.pinPolicy);
  const pinLength = useAuthStore((state) => state.user?.pinLength ?? 4);

  const requestPin = useCallback<RequestPin>((next) => setRequest(next), []);

  const verify = useCallback((pin: string) => verifyPin(pin), [verifyPin]);

  const handleSuccess = useCallback(
    (pin: string) => {
      const pending = request;
      setRequest(null);
      pending?.onConfirm(pin);
    },
    [request],
  );

  const value = useMemo(() => requestPin, [requestPin]);

  return (
    <PinGuardContext.Provider value={value}>
      {children}
      <PinProtectionDialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) setRequest(null);
        }}
        title={request?.title ?? 'Conferma PIN'}
        description={
          request
            ? [request.description, request.action].filter(Boolean).join(' ')
            : 'Azione protetta'
        }
        length={request?.length ?? pinLength}
        maxAttempts={pinPolicy.maxAttempts}
        lockoutMs={pinPolicy.lockoutMs}
        verify={verify}
        onSuccess={handleSuccess}
      />
    </PinGuardContext.Provider>
  );
}

export function usePinGuard(): RequestPin {
  const context = useContext(PinGuardContext);
  if (!context) throw new Error('usePinGuard deve essere usato dentro <PinProvider>');
  return context;
}
