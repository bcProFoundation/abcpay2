import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@bcpros/abcpay-models': resolve(root, '../../packages/abcpay-models/src/index.ts'),
      '@bcpros/abcpay-wallet-core': resolve(root, '../../packages/abcpay-wallet-core/src/index.ts')
    }
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/bws': {
        target: 'http://localhost:3232',
        changeOrigin: true
      }
    }
  }
});
