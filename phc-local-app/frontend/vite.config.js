import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    // Pinned, and strict: the backends' CORS allow-lists name this exact origin,
    // so drifting to another port when 5173 is taken would turn every API call
    // into an opaque CORS failure. Better to refuse to start.
    // PHC_WEB_PORT lets a second checkout run beside this one (default 5173).
    server: { port: Number(env.PHC_WEB_PORT) || 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  }
})
