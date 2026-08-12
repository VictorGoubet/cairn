import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { loadSharedRouteFromUrl } from './lib/share.ts';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

// a route encoded in the URL (#r=...) replaces the draft, recoverable with undo
void loadSharedRouteFromUrl();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
