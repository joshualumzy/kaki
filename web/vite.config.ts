import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3001' },
      '/ws': { target: 'ws://localhost:3001', ws: true },
      // Phones on the Wi-Fi get the app but not the dev routes: only this machine may call them.
      '/dev': {
        target: 'http://localhost:3001',
        bypass: (request) => (LOOPBACK.has(request.socket.remoteAddress ?? '') ? undefined : false),
      },
    },
  },
});
