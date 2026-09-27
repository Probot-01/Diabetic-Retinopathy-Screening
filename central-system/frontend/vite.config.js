import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // '' prefix: read non-VITE_ variables too. CENTRAL_API_PROXY_TARGET is dev-
  // server configuration only and is never exposed to the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  const target = (env.CENTRAL_API_PROXY_TARGET || '').trim()
  if (!target) {
    console.warn('[vite] CENTRAL_API_PROXY_TARGET is not set: /api and /media are not proxied. ' +
      'Set it in central-system/frontend/.env (see .env.example).')
  }

  // Same-origin in dev, exactly as in deployment behind a reverse proxy: the
  // browser only ever talks to this origin, so the httpOnly SameSite=Lax
  // session cookie is first-party on fetch AND on <img src="/media/...">.
  // changeOrigin stays false and the Host header is passed through, so the
  // cookie is never scoped to the backend's host. X-Forwarded-* is added, and
  // the backend trusts it from loopback (TRUST_PROXY).
  const proxy = target
    ? Object.fromEntries(['/api', '/media'].map((p) => [p, { target, changeOrigin: false, xfwd: true }]))
    : undefined

  return {
    plugins: [react()],
    // Pinned, and strict: the backend's CORS allow-list and the dev-up health
    // check name this exact port; drifting when it is taken would break both.
    // CENTRAL_WEB_PORT lets a second checkout run beside this one (default 5174).
    server: { port: Number(env.CENTRAL_WEB_PORT) || 5174, strictPort: true, proxy },
    preview: { port: 4174, strictPort: true, proxy },
  }
})
