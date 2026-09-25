'use strict';

/**
 * loadEnv.js -- one place that decides where this service's config comes from.
 *
 *   require('./loadEnv');   // before anything reads process.env
 *
 * Order, first non-empty value wins:
 *   1. the real environment (shell, CI, docker)
 *   2. phc-local-app/backend/.env           this service's own file
 *   3. <repo root>/.env                     the older shared file, still read so
 *                                           an existing checkout keeps working
 *
 * Explicit paths, never a bare .config(): that resolves against the process
 * cwd, so starting the server from anywhere but this directory would silently
 * load nothing -- taking MATLAB_EXECUTABLE with it, which fails every capture
 * at the quality gate.
 */

const fs   = require('fs');
const path = require('path');

let dotenv;
try {
  dotenv = require('dotenv');
} catch {
  dotenv = null;          // not installed: fall through to the real environment
}

if (dotenv) {
  for (const file of [
    path.join(__dirname, '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ]) {
    let parsed;
    try {
      parsed = dotenv.parse(fs.readFileSync(file));
    } catch {
      continue;                 // file absent: nothing to load from it
    }
    for (const [key, value] of Object.entries(parsed)) {
      // An empty `KEY=` copied from .env.example means "not filled in", not
      // "set to empty": it must not hide a real value in the next file.
      if (value === '') continue;
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
    }
  }
}
