#!/bin/sh
# Builds and launches Sauron detached from this shell.
#   scripts/app.sh        packaged Sauron.app in dist/ (correct name, icon, and bundle id)
#   scripts/app.sh --dev  unpackaged Electron binary (faster; Dock shows "Electron")
set -eu
cd "$(dirname "$0")/.."
pkill -f 'sauron/node_modules/.pnpm/electron' 2>/dev/null || true
pkill -f 'Sauron.app/Contents/MacOS/Sauron' 2>/dev/null || true
if [ "${1:-}" = "--dev" ]; then
  pnpm build
  open -n -a "$PWD/node_modules/electron/dist/Electron.app" --args "$PWD"
else
  pnpm package >/dev/null
  open -n "$PWD/dist/mac-arm64/Sauron.app"
fi
