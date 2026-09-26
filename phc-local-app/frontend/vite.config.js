import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Pinned, and strict: the backends' CORS allow-lists name this exact origin,
  // so drifting to another port when 5173 is taken would turn every API call
  // into an opaque CORS failure. Better to refuse to start.
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
