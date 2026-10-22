import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useHomeStore } from '@/store/homeStore';
import { PinProtectionDialog } from './PinProtectionDialog';

export interface PinRequest {
  title: string;
  description: string;
  /** Etichetta dell'azione mostrata nella descrizione. */
  action?: string;
  length?: 4 | 6;
  onConfirm: () => void;
}

type RequestPin = (request: PinRequest) => void;

const PinGuardContext = createContext<RequestPin | null>(null);

/**
 * Un solo dialog per tutta l'app: qualunque azione sensibile chiama
 * `usePinGuard()({ ... })` e viene eseguita solo dopo la verifica.
 */
export function PinProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PinRequest | null>(null);
  const verifyPin = useHomeStore((state) => state.verifyPin);
  const pinLength = useHomeStore((state) => state.pinLength);

  const requestPin = useCallback<RequestPin>((next) => setRequest(next), []);

  const verify = useCallback((pin: string) => verifyPin(pin), [verifyPin]);

  const handleSuccess = useCallback(() => {
    const pending = request;
    setRequest(null);
    pending?.onConfirm();
  }, [request]);

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
