import { AlertOctagon, RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/** `throw 'string'` e `throw {…}`: il boundary non deve fallire a sua volta. */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Schermata diagnostica ad alto contrasto.
 *
 * Vive fuori dal resto dell'albero visivo: nero pieno, testo bianco e un unico
 * pulsante grande (≥ 56 px) pensato per il dito su un tablet a parete. Non usa
 * store, query né router: se l'errore ha origine lì, questa schermata resta
 * comunque disegnabile.
 */
function ErrorFallback({
  error,
  componentStack,
}: {
  error: Error;
  componentStack: string | null;
}) {
  const { t } = useTranslation();
  const stack = [error.stack, componentStack].filter(Boolean).join('\n\n');

  return (
    <div
      role="alert"
      data-testid="error-boundary"
      className="flex min-h-dvh w-full flex-col items-center justify-center gap-4 bg-black px-6 py-10 text-white"
    >
      <AlertOctagon className="size-12 shrink-0 text-danger" aria-hidden />
      <h1 className="text-center text-xl font-semibold">{t('errorBoundary.title')}</h1>
      <p className="max-w-xl text-center text-sm leading-relaxed text-white/70">
        {t('errorBoundary.description')}
      </p>

      <pre
        data-testid="error-boundary-message"
        className="max-w-2xl overflow-x-auto rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-left text-xs font-mono text-danger"
      >
        {error.name}: {error.message}
      </pre>

      {stack ? (
        <details className="w-full max-w-2xl rounded-xl border border-white/15 bg-white/5 px-3 py-2">
          <summary className="cursor-pointer select-none text-xs font-medium text-white/80">
            {t('errorBoundary.stack')}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-white/60">
            {stack}
          </pre>
        </details>
      ) : null}

      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-2 flex min-h-14 w-full max-w-md items-center justify-center gap-2 rounded-2xl bg-white px-6 text-base font-semibold text-black transition-transform active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <RotateCw className="size-5" aria-hidden />
        {t('errorBoundary.reload')}
      </button>
    </div>
  );
}

/**
 * Error Boundary di radice.
 *
 * React 19 non ha un equivalente funzionale: `getDerivedStateFromError` +
 * `componentDidCatch` restano l'unico modo per intercettare un errore di
 * render, di un `lazy()` o di un effetto. Senza questo componente un errore
 * imprevisto smonta l'intero albero e lascia una pagina nera muta, senza alcun
 * indizio per chi sta davanti al pannello.
 *
 * L'errore viene anche loggato con `console.error` (component stack incluso):
 * è l'unica traccia disponibile quando il kiosk non ha DevTools aperto.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error), componentStack: null };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const normalized = toError(error);
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[ui] errore non gestito durante il render', normalized, info.componentStack);
  }

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} componentStack={componentStack} />;
  }
}
