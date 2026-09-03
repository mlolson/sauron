#!/bin/sh
# Runs the test suite. Works with only the Command Line Tools installed, where the
# Swift Testing framework lives outside the default search path and the Foundation
# cross-import overlay is missing.
set -eu
cd "$(dirname "$0")/.."
F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
if [ -d "$F/Testing.framework" ]; then
  exec swift test \
    -Xswiftc -F"$F" \
    -Xswiftc -Xfrontend -Xswiftc -disable-cross-import-overlays \
    -Xlinker -F"$F" -Xlinker -rpath -Xlinker "$F" "$@"
else
  exec swift test "$@"
fi
