import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// maplibre-gl is excluded from the optimizer: Vite 8 fails to resolve its pre-bundled worker
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
