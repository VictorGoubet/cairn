import { defineConfig } from 'vitest/config';

// unit and regression tests only: the browser paths live in e2e/ and run under playwright
export default defineConfig({
  test: {
    // jsdom for the modules that touch DOMParser or localStorage
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
