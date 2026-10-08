'use strict';

/**
 * pgClient.js
 *
 * Shared PostgreSQL connection pool for the central system backend.
 *
 * Configuration is EITHER/OR, never mixed:
 *
 *   1. DATABASE_URL set  -> the connection string is used, on its own.
 *   2. DATABASE_URL unset -> discrete PGHOST / PGPORT / PGDATABASE / PGUSER /
 *      PGPASSWORD vars are used.
 *
 * The either/or matters. Passing `connectionString` alongside discrete host/
 * user/password fields lets node-postgres silently fall back to the discrete
 * ones when DATABASE_URL is undefined -- which previously meant an unset
 * DATABASE_URL connected as postgres with an EMPTY password instead of failing.
 * That produced confusing "password authentication failed" errors far from the
 * real cause, and is why the verification scripts each hardcode a connection
 * string at the top. Keeping the two paths exclusive makes a misconfiguration
 * fail immediately, with a message that says what is missing.
 *
 * Usage:
 *   const pool = require('../db/pgClient');
 *   const { rows } = await pool.query('SELECT ...', [params]);
 */

const { Pool } = require('pg');

// This service's .env, then the shared root .env (never required -- env vars
// set by the shell or by a calling script always win, since dotenv does not
// overwrite).
require('../loadEnv');

const POOL_TUNING = {
  max: 10,                        // conservative for a single-node central server
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

let config;

if (process.env.DATABASE_URL) {
  config = { connectionString: process.env.DATABASE_URL, ...POOL_TUNING };
} else {
  if (!process.env.PGPASSWORD) {
    console.warn(
      '[pgClient] Neither DATABASE_URL nor PGPASSWORD is set. Connecting with an ' +
      'empty password, which will almost certainly fail.\n' +
      '           Set DATABASE_URL (see central-system/backend/.env.example), e.g. the dev DB:\n' +
      '             postgresql://netrasetu:<password>@localhost:5433/dr_screening_central'
    );
  }
  // Defaults match the Docker dev database (docker-compose.dev.yml, host port
  // 5433) -- the only database this project uses. Never 5432/postgres: that is
  // where a separately installed Postgres would be listening.
  config = {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5433', 10),
    database: process.env.PGDATABASE || 'dr_screening_central',
    user:     process.env.PGUSER     || 'netrasetu',
    password: process.env.PGPASSWORD || '',
    ...POOL_TUNING,
  };
}

const pool = new Pool(config);

// Surface connection errors early rather than failing silently on server start.
pool.on('error', (err) => {
  console.error('[pgClient] Unexpected error on idle client:', err.message);
});

module.exports = pool;
