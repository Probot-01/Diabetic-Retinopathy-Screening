'use strict';

/**
 * setupCentralDb.js
 *
 * Brings the central Postgres database up to date by running every pending
 * migration in central-system/backend/db/migrations (node-pg-migrate).
 *
 * Usage (from central-system/backend: `npm run migrate`):
 *   node scripts/setupCentralDb.js            Apply pending migrations. Safe to
 *                                             re-run; applied ones are skipped.
 *                                             Never drops data.
 *
 *   node scripts/setupCentralDb.js --down     Undo the most recent migration.
 *
 *   node scripts/setupCentralDb.js --reset    DESTRUCTIVE. Drops the entire public
 *                                             schema (all tables, all rows) and
 *                                             re-runs every migration from zero.
 *
 * Migration 0001 is the old db/schema.sql, frozen. It is idempotent, so on a
 * database built before migrations existed it applies as a no-op and is simply
 * recorded as done -- no manual --fake step. Every schema change from then on is
 * a new numbered file; nothing edits 0001.
 *
 * Env vars (see central-system/backend/db/pgClient.js):
 *   DATABASE_URL  or  PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
 */

const path = require('path');
const backendDir = path.resolve(__dirname, '..', 'central-system', 'backend');

const pool = require(path.join(backendDir, 'db', 'pgClient'));
const { runner } = require(require.resolve('node-pg-migrate', { paths: [backendDir] }));

const MIGRATIONS_DIR = path.join(backendDir, 'db', 'migrations');

const RESET = process.argv.includes('--reset');
const DOWN  = process.argv.includes('--down');

async function run() {
  const target = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/:[^:@/]*@/, ':****@')   // mask password
    : `${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5433}` +
      `/${process.env.PGDATABASE || 'dr_screening_central'}`;

  console.log(`[setupCentralDb] Target: ${target}`);

  const client = await pool.connect();
  try {
    if (RESET) {
      console.warn('[setupCentralDb] --reset given: DROPPING SCHEMA public CASCADE.');
      console.warn('[setupCentralDb] All tables and all rows will be destroyed.');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      console.log('[setupCentralDb] Schema dropped and recreated empty.');
    }

    const applied = await runner({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      direction: DOWN ? 'down' : 'up',
      count: DOWN ? 1 : Infinity,
      migrationsTable: 'pgmigrations',
      singleTransaction: true,
      checkOrder: true,
      log: () => {},          // the SQL is in the files; print only the outcome
    });

    if (!applied.length) {
      console.log('[setupCentralDb] Nothing to do: database is up to date.');
    } else {
      for (const m of applied) {
        console.log(`[setupCentralDb] ${DOWN ? 'reverted' : 'applied'}  ${m.name}`);
      }
    }

    // Report what actually landed, so a silent no-op is visible rather than
    // being reported as success.
    const { rows } = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    console.log(`[setupCentralDb] ${rows.length} tables present:`);
    for (const r of rows) console.log(`    - ${r.table_name}`);
  } catch (err) {
    console.error('[setupCentralDb] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
