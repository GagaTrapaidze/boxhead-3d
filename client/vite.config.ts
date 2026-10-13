import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true, // reachable from other devices on the LAN for cross-device testing
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
