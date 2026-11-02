#!/bin/sh
set -eu
cd "$(dirname "$0")"
swift build -c release
app="${1:-build/Clicky for BB.app}"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp .build/release/ClickyBB "$app/Contents/MacOS/ClickyBB"
cp Info.plist "$app/Contents/Info.plist"
cp ../instructions/companion.md "$app/Contents/Resources/companion.md"
codesign --force --sign - --identifier app.getbb.clicky-companion "$app"
printf 'Built %s\n' "$app"
