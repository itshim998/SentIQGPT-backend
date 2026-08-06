#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

flutter create \
  --platforms=android \
  --org com.sentiqlabs \
  --project-name sentiq_chat \
  --empty \
  .

python3 - <<'PY'
from pathlib import Path

candidates = [
    Path("android/app/build.gradle.kts"),
    Path("android/app/build.gradle"),
]
for path in candidates:
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        'applicationId = "com.sentiqlabs.sentiq_chat"',
        'applicationId = "com.sentiqlabs.sentiqchat"',
    )
    text = text.replace(
        'applicationId "com.sentiqlabs.sentiq_chat"',
        'applicationId "com.sentiqlabs.sentiqchat"',
    )
    text = text.replace("minSdk = flutter.minSdkVersion", "minSdk = 28")
    text = text.replace("minSdkVersion flutter.minSdkVersion", "minSdkVersion 28")
    path.write_text(text, encoding="utf-8")
    break
else:
    raise SystemExit("Android application Gradle file was not generated")

manifest_path = Path("android/app/src/main/AndroidManifest.xml")
manifest = manifest_path.read_text(encoding="utf-8")
permission = '    <uses-permission android:name="android.permission.INTERNET" />\n'
if "android.permission.INTERNET" not in manifest:
    manifest = manifest.replace(
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' + permission,
        1,
    )
manifest = manifest.replace('android:label="sentiq_chat"', 'android:label="SentIQ Chat"')
if "android:allowBackup" not in manifest:
    manifest = manifest.replace(
        'android:icon="@mipmap/ic_launcher">',
        'android:icon="@mipmap/ic_launcher"\n'
        '        android:allowBackup="false"\n'
        '        android:enableOnBackInvokedCallback="true">',
        1,
    )

deep_links = '''
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data
                    android:scheme="com.sentiqlabs.sentiqchat"
                    android:host="login-callback" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data
                    android:scheme="com.sentiqlabs.sentiqchat"
                    android:host="reset-callback" />
            </intent-filter>'''
if "login-callback" not in manifest:
    manifest = manifest.replace("        </activity>", deep_links + "\n        </activity>", 1)
manifest_path.write_text(manifest, encoding="utf-8")

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
grep -q 'android:host="login-callback"' android/app/src/main/AndroidManifest.xml
grep -q 'android:host="reset-callback"' android/app/src/main/AndroidManifest.xml
grep -q 'android:windowSoftInputMode="adjustResize"' android/app/src/main/AndroidManifest.xml

printf 'Android scaffold ready: com.sentiqlabs.sentiqchat, API 28+, auth deep links enabled\n'
