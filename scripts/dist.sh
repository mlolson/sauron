#!/bin/sh
# Builds a signed, notarized DMG (and zip) of Sauron into dist/.
#
# Needs, once per machine:
#   1. A "Developer ID Application" certificate in the login keychain (Xcode > Settings >
#      Accounts > Manage Certificates, or developer.apple.com). electron-builder finds it.
#   2. Notarization credentials stored as a keychain profile:
#        xcrun notarytool store-credentials sauron-notary --apple-id <you@example.com> --team-id <TEAMID>
#      (an app-specific password from appleid.apple.com is what it asks for).
#
# Pass --unsigned to build the DMG without signing or notarizing, for a local check.
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--unsigned" ]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  echo "Building an unsigned DMG (will not open on other Macs without right-click > Open)."
else
  if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
    echo "No 'Developer ID Application' certificate in the keychain. Install one, or pass --unsigned." >&2
    exit 1
  fi
  export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-sauron-notary}"
  if ! xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" >/dev/null 2>&1; then
    echo "No notarization profile '$APPLE_KEYCHAIN_PROFILE' in the keychain; see the comment at the top of this script." >&2
    exit 1
  fi
fi

scripts/make-icon.sh
pnpm -s electron-vite build
pnpm -s electron-builder --mac

# electron-builder notarizes and staples the app. The DMG that wraps it is signed but not
# notarized, so Gatekeeper's assessment of the disk image itself would still be "no usable
# signature". Notarize and staple the DMG too, so both the container and its contents pass.
if [ "${1:-}" != "--unsigned" ]; then
  for dmg in dist/*.dmg; do
    echo "Notarizing $dmg (this waits on Apple's queue)..."
    xcrun notarytool submit "$dmg" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
    xcrun stapler staple "$dmg"
    spctl -a -vv -t install "$dmg"
  done
fi
ls -la dist/*.dmg dist/*.zip 2>/dev/null
