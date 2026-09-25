// Runtime configuration, all from Vite env (central-system/frontend/.env; see
// .env.example). Nothing here has a hardcoded host: a missing URL is reported
// as an error on screen, never silently pointed at localhost.

const env = import.meta.env ?? {};

/**
 * DATA_MODE — 'live' (default) or 'mock'.
 *
 * live: every screen talks to the central API. A failed request shows an error
 *       state; it never substitutes mock data (design doc §1.22).
 * mock: every screen shows fixture data from api/mockData.js, and a
 *       persistent "DEMO DATA" banner is rendered on every page.
 *
 * There is no automatic switch between the two. Anything other than 'mock'
 * or 'live' is treated as live and logged, so a typo can never quietly put
 * fixture data in front of a clinician.
 */
const rawMode = (env.VITE_DATA_MODE ?? '').trim().toLowerCase();
if (rawMode && rawMode !== 'live' && rawMode !== 'mock') {
  console.error(`[config] VITE_DATA_MODE="${env.VITE_DATA_MODE}" is not 'live' or 'mock'; using live.`);
}
export const DATA_MODE = rawMode === 'mock' ? 'mock' : 'live';
export const USE_MOCK_DATA = DATA_MODE === 'mock';

/** Central backend base URL, e.g. http://localhost:5000. No default. */
export const CENTRAL_API_BASE = (env.VITE_CENTRAL_API_BASE ?? '').trim().replace(/\/+$/, '');
