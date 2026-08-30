import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    pool: 'threads',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 30000,
  },
});
