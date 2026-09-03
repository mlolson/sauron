#!/bin/sh
# Renders resources/eye.png into build/icon.png and build/icon.icns using only macOS tools.
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/icon.iconset
swift scripts/make-icon.swift resources/eye.png build/icon.png
for size in 16 32 128 256 512; do
  sips -z $size $size build/icon.png --out build/icon.iconset/icon_${size}x${size}.png >/dev/null
  double=$((size * 2))
  sips -z $double $double build/icon.png --out build/icon.iconset/icon_${size}x${size}@2x.png >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
echo "wrote build/icon.png and build/icon.icns"
