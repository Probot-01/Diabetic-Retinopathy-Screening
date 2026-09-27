import { defineConfig } from 'vite';

// Port 5180 keeps clear of the PHC app (5173) and central app (5174),
// which the role buttons link to.
export default defineConfig({
  server: { port: 5180 },
  preview: { port: 5180 },
  // The anatomy chunk is three.js, loaded lazily while the intro plays.
  build: { target: 'es2020', chunkSizeWarningLimit: 700 },
});
