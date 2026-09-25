import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Pinned, and strict: the central backend's CORS allow-list names this exact
  // origin, so drifting to another port when 5174 is taken would turn every
  // API call into an opaque CORS failure. Better to refuse to start.
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
})
