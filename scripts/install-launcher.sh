#!/bin/sh
# Installs two ways to start the dev build without a terminal open in the repo:
#   ~/.local/bin/sauron-dev      shell command
#   ~/Desktop/Sauron.app         double-clickable launcher with the eye icon
set -eu
cd "$(dirname "$0")/.."
REPO="$PWD"

mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/scripts/app.sh" "$HOME/.local/bin/sauron-dev"
echo "installed ~/.local/bin/sauron-dev"

[ -f build/icon.icns ] || scripts/make-icon.sh >/dev/null
APP="$HOME/Desktop/Sauron.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp build/icon.icns "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Sauron</string>
  <key>CFBundleDisplayName</key><string>Sauron</string>
  <key>CFBundleIdentifier</key><string>com.mattolson.sauron.launcher</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/sh
# Finder gives us a bare environment; run the build through the login shell so pnpm is found.
exec "\${SHELL:-/bin/zsh}" -lc 'cd "$REPO" && scripts/app.sh' > /tmp/sauron-launcher.log 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"
echo "installed $APP"
