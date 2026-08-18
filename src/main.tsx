import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { loadSharedRouteFromUrl } from './lib/share.ts';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

// a route encoded in the URL (#r=...) replaces the draft, recoverable with undo
void loadSharedRouteFromUrl();

// offline: the shell and every tile already seen keep working without a network. Dev stays
// uncached, or the worker would serve yesterday's code over the dev server's
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
