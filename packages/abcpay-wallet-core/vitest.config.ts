import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bcpros/abcpay-models': resolve(root, '../abcpay-models/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts']
  }
});
