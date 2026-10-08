// Runtime configuration, all from Vite env (phc-local-app/frontend/.env; see
// .env.example). Nothing here has a hardcoded host: a missing URL is reported
// as an error on screen, never silently pointed at localhost.

const env = import.meta.env ?? {};

/**
 * DATA_MODE — 'live' (default) or 'mock'.
 *
 * live: every screen talks to the PHC local backend. A failed request shows an
 *       error; it never substitutes mock data or an invented quality result
 *       (design doc §1.22).
 * mock: fixture data from api/mockData.js only, with a persistent
 *       "DEMO DATA" banner on every page.
 *
 * There is no automatic switch between the two. Anything other than 'mock'
 * or 'live' is treated as live and logged.
 */
const rawMode = (env.VITE_DATA_MODE ?? '').trim().toLowerCase();
if (rawMode && rawMode !== 'live' && rawMode !== 'mock') {
  console.error(`[config] VITE_DATA_MODE="${env.VITE_DATA_MODE}" is not 'live' or 'mock'; using live.`);
}
export const DATA_MODE = rawMode === 'mock' ? 'mock' : 'live';
export const USE_MOCK_DATA = DATA_MODE === 'mock';

/** PHC local backend base URL, e.g. http://localhost:4000. No default. */
export const LOCAL_API_BASE = (env.VITE_LOCAL_API_BASE ?? '').trim().replace(/\/+$/, '');

/** Display name of this site in the header. Label only. */
export const PHC_NAME = (env.VITE_PHC_NAME ?? '').trim() || 'PHC';
