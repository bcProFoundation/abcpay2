import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ['buffer', 'process', 'events', 'stream', 'util', 'crypto']
    })
  ],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/cws': {
        target: 'http://localhost:3232',
        changeOrigin: true
      },
      '/bws': {
        target: 'http://localhost:3232',
        changeOrigin: true
      },
      // Same-origin Cashtab icons (Brave blocks third-party icons.etokens.cash).
      '/token-icons': {
        target: 'https://icons.etokens.cash',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/token-icons/, '')
      }
    }
  },
  define: {
    global: 'globalThis'
  }
});
