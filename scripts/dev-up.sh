#!/usr/bin/env sh
# Start the whole NetraSetu system locally. All logic lives in dev-up.js so
# Windows and POSIX behave identically; see that file for the steps and flags.
#   scripts/dev-up.sh            start everything, Ctrl+C stops it
#   scripts/dev-up.sh --check    start, verify health, stop
set -e
cd "$(dirname "$0")/.."
exec node scripts/dev-up.js "$@"
