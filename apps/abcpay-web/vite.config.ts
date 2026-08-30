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
    proxy: {
      '/bws': {
        target: 'http://localhost:3232',
        changeOrigin: true
      }
    }
  },
  define: {
    global: 'globalThis'
  }
});
