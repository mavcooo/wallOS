import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import './i18n';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root non trovato');

createRoot(container).render(
  <StrictMode>
    {/* Radice: un errore di render/lazy chunk mostra la diagnostica invece di
        una pagina nera muta. La schermata è già montata sul pannello. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
