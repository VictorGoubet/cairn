/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// maplibre-gl is excluded from the optimizer: Vite 8 fails to resolve its pre-bundled worker
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['maplibre-gl'] },
  // unit and regression tests; the browser paths live in tests/e2e under playwright
  test: {
    // jsdom for the modules that touch DOMParser or localStorage
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    restoreMocks: true,
  },
});
