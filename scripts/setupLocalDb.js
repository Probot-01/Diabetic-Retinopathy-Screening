'use strict';

/**
 * setupLocalDb.js
 *
 * Creates/updates the PHC local SQLite database at
 * phc-local-app/backend/db/local.sqlite and applies schema.sql to it.
 *
 * Usage:
 *   node scripts/setupLocalDb.js            Create/update. Idempotent -- every
 *                                           statement is CREATE ... IF NOT EXISTS.
 *   node scripts/setupLocalDb.js --reset    DESTRUCTIVE. Deletes local.sqlite
 *                                           entirely and rebuilds it empty.
 *
 * Requiring db/localDb.js is itself enough to create and migrate the database,
 * so this script exists mostly to make that side effect explicit and to report
 * the result -- and to provide the --reset path, which the module cannot.
 */

const fs   = require('fs');
const path = require('path');

const DB_DIR  = path.resolve(__dirname, '..', 'phc-local-app', 'backend', 'db');
const DB_PATH = path.join(DB_DIR, 'local.sqlite');

const RESET = process.argv.includes('--reset');

if (RESET) {
  console.warn('[setupLocalDb] --reset given: deleting local.sqlite and all its rows.');
  // WAL mode leaves sidecar files; remove them too or SQLite will restore
  // pages from the old write-ahead log into the "fresh" database.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[setupLocalDb] removed ${path.basename(p)}`);
    }
  }
}

// This require creates the file and applies schema.sql as a side effect.
const db = require(path.join(DB_DIR, 'localDb.js'));

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`[setupLocalDb] Database ready at ${DB_PATH}`);
console.log(`[setupLocalDb] ${tables.length} tables present:`);
for (const t of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get();
  console.log(`    - ${t} (${n} rows)`);
}

db.close();
