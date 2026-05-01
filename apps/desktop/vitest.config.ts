import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    alias: {
      // Allow importing '@tday/shared' in tests without bundling the whole package
      '@tday/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
