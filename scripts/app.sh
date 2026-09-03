#!/bin/sh
# Builds and launches Sauron detached from this shell.
#   scripts/app.sh              unpackaged Electron binary (fast; Dock shows "Electron")
#   scripts/app.sh --packaged   dist/mac-arm64/Sauron.app (correct name and bundle id; slower)
set -eu
cd "$(dirname "$0")/.."
pkill -f 'sauron/node_modules/.pnpm/electron' 2>/dev/null || true
pkill -f 'Sauron.app/Contents/MacOS/Sauron' 2>/dev/null || true
if [ "${1:-}" = "--packaged" ]; then
  pnpm package >/dev/null
  open -n "$PWD/dist/mac-arm64/Sauron.app"
else
  pnpm build >/dev/null
  open -n -a "$PWD/node_modules/electron/dist/Electron.app" --args "$PWD"
fi
