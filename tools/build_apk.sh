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
npm install --no-audit --no-fund @capacitor/core@6.2.0 @capacitor/cli@6.2.0 @capacitor/android@6.2.0 \
  @capacitor/filesystem@6.0.1 @capacitor/share@6.0.2 @capacitor-community/text-to-speech@4.1.1
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

# The WebView must play the camera stream without an extra tap, and keep the screen on.
MAIN=$(find android/app/src/main/java -name MainActivity.java)
PKG=$(sed -n 's/^package \(.*\);/\1/p' "$MAIN")
cat > "$MAIN" <<JAVA
package $PKG;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        this.bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
}
JAVA

cd android
chmod +x gradlew
./gradlew --no-daemon assembleDebug
mkdir -p "$ROOT/build"
cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/build/ma-roim.apk"
ls -la "$ROOT/build/ma-roim.apk"
