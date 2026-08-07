#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRESERVE_DIR="$(mktemp -d)"
trap 'rm -rf "$PRESERVE_DIR"' EXIT

preserve_file() {
  local source="$1"
  local target="$2"
  if [[ -f "$source" ]]; then
    mkdir -p "$(dirname "$PRESERVE_DIR/$target")"
    cp "$source" "$PRESERVE_DIR/$target"
  fi
}

preserve_file android/app/src/main/AndroidManifest.xml AndroidManifest.xml
preserve_file android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt MainActivity.kt
preserve_file android/app/build.gradle.kts build.gradle.kts
preserve_file android/app/proguard-rules.pro proguard-rules.pro
if [[ -d android/app/src/main/res ]]; then
  cp -R android/app/src/main/res "$PRESERVE_DIR/res"
fi

flutter create \
  --platforms=android \
  --org com.sentiqlabs \
  --project-name sentiq_chat \
  --empty \
  .

restore_file() {
  local source="$1"
  local target="$2"
  if [[ -f "$PRESERVE_DIR/$source" ]]; then
    mkdir -p "$(dirname "$target")"
    cp "$PRESERVE_DIR/$source" "$target"
  fi
}

restore_file AndroidManifest.xml android/app/src/main/AndroidManifest.xml
restore_file MainActivity.kt android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt
restore_file build.gradle.kts android/app/build.gradle.kts
restore_file proguard-rules.pro android/app/proguard-rules.pro
if [[ -d "$PRESERVE_DIR/res" ]]; then
  rm -rf android/app/src/main/res
  cp -R "$PRESERVE_DIR/res" android/app/src/main/res
fi

python3 - <<'PY'
from pathlib import Path

# Local development can reach the emulator host over HTTP. Production uses the
# main manifest, whose cleartext policy is explicitly disabled.
debug_manifest_path = Path("android/app/src/debug/AndroidManifest.xml")
debug_manifest = debug_manifest_path.read_text(encoding="utf-8")
if "usesCleartextTraffic" not in debug_manifest:
    debug_manifest = debug_manifest.replace(
        "</manifest>",
        '    <application android:usesCleartextTraffic="true" />\n</manifest>',
    )
debug_manifest_path.write_text(debug_manifest, encoding="utf-8")
PY

grep -q 'applicationId = "com.sentiqlabs.sentiqchat"' android/app/build.gradle.kts
grep -q 'minSdk = 28' android/app/build.gradle.kts
grep -q 'isMinifyEnabled = true' android/app/build.gradle.kts
grep -q 'isShrinkResources = true' android/app/build.gradle.kts
grep -q 'android:host="login-callback"' android/app/src/main/AndroidManifest.xml
grep -q 'android:host="reset-callback"' android/app/src/main/AndroidManifest.xml
grep -q 'android:windowSoftInputMode="adjustResize"' android/app/src/main/AndroidManifest.xml
grep -q 'android:usesCleartextTraffic="false"' android/app/src/main/AndroidManifest.xml
! grep -q 'android.permission.CAMERA' android/app/src/main/AndroidManifest.xml
grep -q 'android.permission.RECORD_AUDIO' android/app/src/main/AndroidManifest.xml
grep -q 'android.permission.MODIFY_AUDIO_SETTINGS' android/app/src/main/AndroidManifest.xml
grep -q 'sentiq_file_paths' android/app/src/main/AndroidManifest.xml
grep -q 'com.sentiqlabs.sentiqchat/artifacts' android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt
grep -q 'com.sentiqlabs.sentiqchat/live_audio' android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt
test -f android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
test -f android/app/src/main/res/values-v31/styles.xml

printf 'Android scaffold ready: release-safe transport, R8, adaptive icon, splash, and API 28+\n'
