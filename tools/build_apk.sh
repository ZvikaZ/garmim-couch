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
# A tiny local plugin asks Android for audio focus around spoken messages, so music
# pauses (or gets quieter) while the app speaks, like navigation apps do.
MAIN=$(find android/app/src/main/java -name MainActivity.java)
PKG=$(sed -n 's/^package \(.*\);/\1/p' "$MAIN")
cat > "$(dirname "$MAIN")/AudioFocusPlugin.java" <<JAVA
package $PKG;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioFocus")
public class AudioFocusPlugin extends Plugin {
    private AudioFocusRequest req;

    private AudioManager am() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void request(PluginCall call) {
        boolean duck = Boolean.TRUE.equals(call.getBoolean("duck", false));
        int gain = duck ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
        int res;
        if (Build.VERSION.SDK_INT >= 26) {
            req = new AudioFocusRequest.Builder(gain)
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .build();
            res = am().requestAudioFocus(req);
        } else {
            res = am().requestAudioFocus(null, AudioManager.STREAM_MUSIC, gain);
        }
        JSObject r = new JSObject();
        r.put("granted", res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void release(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) { if (req != null) am().abandonAudioFocusRequest(req); }
        else am().abandonAudioFocus(null);
        req = null;
        call.resolve();
    }
}
JAVA

cat > "$MAIN" <<JAVA
package $PKG;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioFocusPlugin.class);
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
