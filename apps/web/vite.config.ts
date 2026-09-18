import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@supops/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 3000,
    /**
     * This project lives on /mnt/c, which WSL exposes as v9fs -- a filesystem with no
     * inotify support. Without polling, Vite's watcher never fires: edits appear to
     * save correctly but the dev server keeps serving the previously transformed
     * module, and HMR silently does nothing. Polling costs a little CPU and is the
     * only thing that works here.
     */
    watch: { usePolling: true, interval: 300 },
    proxy: {
      // Keeps the browser on one origin in dev, so no CORS and no token juggling.
      '/api': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
