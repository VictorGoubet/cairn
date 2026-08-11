import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// maplibre-gl est exclu de l'optimiseur: Vite 8 ne résout pas son worker pré-bundlé
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
