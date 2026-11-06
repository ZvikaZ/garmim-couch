#!/usr/bin/env bash
# Wrap the web app in an Android WebView app with Capacitor and build a debug APK.
# Output: build/ma-roim.apk
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/build/android-app"
rm -rf "$WORK" && mkdir -p "$WORK/www"
cp -r "$ROOT/index.html" "$ROOT/style.css" "$ROOT/js" "$ROOT/data" "$ROOT/icon.svg" "$ROOT/manifest.webmanifest" "$WORK/www/"

cd "$WORK"
cat > package.json <<'JSON'
{ "name": "ma-roim-android", "private": true, "version": "0.0.0" }
JSON
npm install --no-audit --no-fund @capacitor/core@6.2.0 @capacitor/cli@6.2.0 @capacitor/android@6.2.0
cat > capacitor.config.json <<'JSON'
{
  "appId": "io.github.zvikaz.maroim",
  "appName": "מה רואים",
  "webDir": "www",
  "android": { "allowMixedContent": false }
}
JSON
npx cap add android
npx cap sync android

MANIFEST=android/app/src/main/AndroidManifest.xml
python3 - "$MANIFEST" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
perms = """
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
"""
if "android.permission.CAMERA" not in s:
    s = s.replace("<application", perms + "\n    <application", 1)
# keep the screen in portrait-friendly fullscreen activity; keep screen awake handled in JS
open(p, "w", encoding="utf-8").write(s)
PY

cd android
chmod +x gradlew
./gradlew --no-daemon assembleDebug
mkdir -p "$ROOT/build"
cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/build/ma-roim.apk"
ls -la "$ROOT/build/ma-roim.apk"
