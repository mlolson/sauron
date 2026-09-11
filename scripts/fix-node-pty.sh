#!/bin/sh
# node-pty needs its spawn-helper to be executable. pnpm can extract the prebuilt one without
# the execute bit, and electron-rebuild cannot always rebuild (for example before the Xcode
# licence has been accepted), in which case Electron falls back to that prebuilt copy and every
# terminal fails with "posix_spawnp failed". Restoring the bit is enough.
set -eu
cd "$(dirname "$0")/.."
find node_modules/.pnpm -path "*node-pty*" \( -name spawn-helper \) -exec chmod +x {} \; 2>/dev/null || true
