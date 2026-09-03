#!/bin/sh
# Builds Sauron.app into build/ from the Swift package. Usage: scripts/build-app.sh [debug|release]
set -eu
cd "$(dirname "$0")/.."
CONFIG="${1:-debug}"
swift build -c "$CONFIG" --product Sauron
BIN="$(swift build -c "$CONFIG" --show-bin-path)"
APP=build/Sauron.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Sauron" "$APP/Contents/MacOS/Sauron"
cp Resources/Info.plist "$APP/Contents/Info.plist"
echo "APPL????" > "$APP/Contents/PkgInfo"
# Ad-hoc sign so macOS grants the process a stable identity for notifications and defaults.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built $APP"
