#!/usr/bin/env bash
# Builds dist/transac.apk without Gradle, using the Android SDK build-tools.
# Requires: JDK 11+, Android SDK platform 34 and build-tools 34.0.0.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/android-app"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/tmp/opencode/android-sdk}}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
KEYSTORE="$APP/transac.keystore"
ALIAS="transac"
PASS="transac123"

if [[ ! -x "$BT/aapt2" || ! -f "$PLATFORM" ]]; then
  echo "Android SDK not found at $SDK" >&2
  echo "Install platform 34 and build-tools 34.0.0, or set ANDROID_HOME." >&2
  exit 1
fi

echo "==> Copying web UI into the APK assets"
rm -rf "$APP/assets/www"
mkdir -p "$APP/assets/www/icons"
cp "$ROOT/public/index.html" "$ROOT/public/app.js" "$ROOT/public/styles.css" "$ROOT/public/manifest.webmanifest" "$APP/assets/www/"
cp "$ROOT/public/icons/icon.svg" "$ROOT/public/icons/icon-192.png" "$ROOT/public/icons/icon-512.png" "$APP/assets/www/icons/"

echo "==> Preparing build directories"
rm -rf "$APP/build"
mkdir -p "$APP/build/compiled" "$APP/build/classes" "$APP/build/dex" "$APP/build/gen" "$APP/res/drawable" "$ROOT/dist"
cp "$ROOT/public/icons/icon-192.png" "$APP/res/drawable/appicon.png"

echo "==> Compiling resources"
"$BT/aapt2" compile --dir "$APP/res" -o "$APP/build/compiled/res.zip"

echo "==> Linking resources and manifest"
"$BT/aapt2" link \
  -o "$APP/build/app-unsigned.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/AndroidManifest.xml" \
  -A "$APP/assets" \
  --java "$APP/build/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  "$APP/build/compiled/res.zip"

echo "==> Compiling Java sources"
find "$APP/java" "$APP/build/gen" -name '*.java' > "$APP/build/sources.txt"
javac -source 8 -target 8 -encoding UTF-8 \
  -classpath "$PLATFORM" \
  -d "$APP/build/classes" \
  @"$APP/build/sources.txt"

echo "==> Dexing"
"$BT/d8" --lib "$PLATFORM" --min-api 24 --release --output "$APP/build/dex" \
  $(find "$APP/build/classes" -name '*.class')

cp "$APP/build/app-unsigned.apk" "$APP/build/app-with-dex.apk"
(cd "$APP/build/dex" && zip -q "$APP/build/app-with-dex.apk" classes.dex)

echo "==> Aligning"
"$BT/zipalign" -f 4 "$APP/build/app-with-dex.apk" "$APP/build/app-aligned.apk"

if [[ ! -f "$KEYSTORE" ]]; then
  echo "==> Creating demo signing key"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=TRANSAC, OU=Capstone, O=TRANSAC, L=Manila, S=Metro Manila, C=PH" >/dev/null 2>&1
fi

echo "==> Signing"
"$BT/apksigner" sign \
  --ks "$KEYSTORE" --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --out "$ROOT/dist/transac.apk" \
  "$APP/build/app-aligned.apk"

"$BT/apksigner" verify --print-certs "$ROOT/dist/transac.apk" | head -3
"$BT/aapt" dump badging "$ROOT/dist/transac.apk" | grep -E "^(package|application-label|sdkVersion|targetSdkVersion)" || true
ls -lh "$ROOT/dist/transac.apk"
echo "==> Built $ROOT/dist/transac.apk"
