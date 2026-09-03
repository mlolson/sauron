#!/bin/sh
# Builds and launches Sauron in unpackaged form via launchd (`open`), detached from this shell.
set -eu
cd "$(dirname "$0")/.."
pnpm build
pkill -f 'sauron/node_modules/.pnpm/electron' 2>/dev/null || true
open -n -a "$PWD/node_modules/electron/dist/Electron.app" --args "$PWD"
