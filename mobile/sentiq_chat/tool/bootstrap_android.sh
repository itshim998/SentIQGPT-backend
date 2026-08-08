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

GRADLE_PROPERTIES="android/gradle/wrapper/gradle-wrapper.properties"
GRADLE_SHA256="b84e04fa845fecba48551f425957641074fcc00a88a84d2aae5808743b35fc85"
grep -q '^distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-all.zip$' "$GRADLE_PROPERTIES"
if grep -q '^distributionSha256Sum=' "$GRADLE_PROPERTIES"; then
  sed -i "s/^distributionSha256Sum=.*/distributionSha256Sum=${GRADLE_SHA256}/" "$GRADLE_PROPERTIES"
else
  printf '\ndistributionSha256Sum=%s\n' "$GRADLE_SHA256" >> "$GRADLE_PROPERTIES"
fi
grep -q "^distributionSha256Sum=${GRADLE_SHA256}$" "$GRADLE_PROPERTIES"

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

# Development may reach a local emulator-host API over HTTP. Keep that exception
# in the debug source set only; the main/production manifest and network policy
# remain HTTPS-only. tools:replace is required because the main manifest sets
# usesCleartextTraffic=false intentionally.
cat > android/app/src/debug/AndroidManifest.xml <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:usesCleartextTraffic="true"
        android:networkSecurityConfig="@xml/network_security_config"
        tools:replace="android:usesCleartextTraffic" />
</manifest>
XML

mkdir -p android/app/src/debug/res/xml
cat > android/app/src/debug/res/xml/network_security_config.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
XML

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
grep -q 'tools:replace="android:usesCleartextTraffic"' android/app/src/debug/AndroidManifest.xml
grep -q 'cleartextTrafficPermitted="true"' android/app/src/debug/res/xml/network_security_config.xml
grep -q 'cleartextTrafficPermitted="false"' android/app/src/main/res/xml/network_security_config.xml
grep -q 'com.sentiqlabs.sentiqchat/artifacts' android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt
grep -q 'com.sentiqlabs.sentiqchat/live_audio' android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt
test -f android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
test -f android/app/src/main/res/values-v31/styles.xml

printf 'Android scaffold ready: release-safe transport, debug-local transport override, R8, adaptive icon, splash, and API 28+\n'
