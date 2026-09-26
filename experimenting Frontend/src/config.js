// Role destinations, from Vite env (see .env.example). No hardcoded hosts: a
// role whose URL is not set is shown as unavailable rather than linking to a
// guessed localhost port.
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const ROLE_URLS = {
  // central-system/frontend (http://localhost:5174 in local dev)
  ophthalmologist: clean(import.meta.env.VITE_OPHTHALMOLOGIST_URL),
  // phc-local-app/frontend (http://localhost:5173 in local dev)
  nurse: clean(import.meta.env.VITE_NURSE_URL),
};
