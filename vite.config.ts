import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const sharedDir = fileURLToPath(new URL('./shared', import.meta.url));
// Dev server: run the backend with TLS_MODE=off (plain HTTP on WEB_PORT 8443).
const devApi = process.env.CTD_DEV_API ?? 'http://127.0.0.1:8443';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: { '@shared': sharedDir },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: devApi, ws: true, changeOrigin: false },
      '/overlay': { target: devApi, ws: true, changeOrigin: false },
    },
  },
});
