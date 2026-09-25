# Start the whole NetraSetu system locally (Windows PowerShell). All logic
# lives in dev-up.js so Windows and POSIX behave identically; see that file
# for the steps and flags.
#   .\scripts\dev-up.ps1            start everything, Ctrl+C stops it
#   .\scripts\dev-up.ps1 --check    start, verify health, stop
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
node scripts/dev-up.js @args
exit $LASTEXITCODE
