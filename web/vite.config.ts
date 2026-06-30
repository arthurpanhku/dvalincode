import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.DVALINCODE_API_PORT ?? '3001';
const apiHost = process.env.DVALINCODE_API_HOST ?? '127.0.0.1';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/highlight.js/')) {
            return 'vendor-highlight';
          }
          if (
            id.includes('node_modules/react-markdown/') ||
            id.includes('node_modules/remark-gfm/') ||
            id.includes('node_modules/rehype-highlight/')
          ) {
            return 'vendor-markdown';
          }
        },
      },
    },
  },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    open: process.env.VITE_AUTO_OPEN === '0' ? false : true,
    proxy: {
      '/api': `http://${apiHost}:${apiPort}`,
      '/ws': {
        target: `ws://${apiHost}:${apiPort}`,
        ws: true,
      },
    },
  },
});
