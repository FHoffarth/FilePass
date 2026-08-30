import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Audit-only config. The product config (vite.config.ts) is left untouched.
export default defineConfig({
  plugins: [react()],
  test: {
    pool: 'threads',
    include: ['audit/**/*.test.{ts,tsx}'],
    testTimeout: 60000,
    root: process.cwd(),
  },
});
