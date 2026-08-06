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
permissions = (
    '    <uses-permission android:name="android.permission.INTERNET" />\n'
    '    <uses-permission android:name="android.permission.CAMERA" />\n'
)
if "android.permission.INTERNET" not in manifest:
    manifest = manifest.replace(
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' + permissions,
        1,
    )
if "android.permission.CAMERA" not in manifest:
    manifest = manifest.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.CAMERA" />',
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
provider = """
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.files"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/sentiq_file_paths" />
        </provider>"""
if "sentiq_file_paths" not in manifest:
    manifest = manifest.replace("    </application>", provider + "\n    </application>", 1)
manifest_path.write_text(manifest, encoding="utf-8")

debug_manifest_path = Path("android/app/src/debug/AndroidManifest.xml")
debug_manifest = debug_manifest_path.read_text(encoding="utf-8")
if "usesCleartextTraffic" not in debug_manifest:
    debug_manifest = debug_manifest.replace(
        "</manifest>",
        '    <application android:usesCleartextTraffic="true" />\n</manifest>',
    )
debug_manifest_path.write_text(debug_manifest, encoding="utf-8")

paths = Path("android/app/src/main/res/xml/sentiq_file_paths.xml")
paths.parent.mkdir(parents=True, exist_ok=True)
paths.write_text("""<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="shared" path="sentiq-shared/" />
    <external-files-path name="downloads" path="Download/" />
</paths>
""", encoding="utf-8")

activity = Path("android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt")
activity.parent.mkdir(parents=True, exist_ok=True)
activity.write_text('package com.sentiqlabs.sentiq_chat\n\nimport android.content.ClipData\nimport android.content.ContentValues\nimport android.content.Intent\nimport android.os.Build\nimport android.os.Environment\nimport android.provider.MediaStore\nimport androidx.core.content.FileProvider\nimport io.flutter.embedding.android.FlutterActivity\nimport io.flutter.embedding.engine.FlutterEngine\nimport io.flutter.plugin.common.MethodCall\nimport io.flutter.plugin.common.MethodChannel\nimport java.io.File\n\nclass MainActivity : FlutterActivity() {\n    private val channelName = "com.sentiqlabs.sentiqchat/artifacts"\n\n    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {\n        super.configureFlutterEngine(flutterEngine)\n        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)\n            .setMethodCallHandler { call, result -> handleArtifactCall(call, result) }\n    }\n\n    private fun handleArtifactCall(call: MethodCall, result: MethodChannel.Result) {\n        try {\n            val bytes = call.argument<ByteArray>("bytes") ?: throw IllegalArgumentException("Missing file bytes")\n            val filename = safeFilename(call.argument<String>("filename") ?: "sentiq-file")\n            val mimeType = call.argument<String>("mimeType") ?: "application/octet-stream"\n            when (call.method) {\n                "saveFile" -> result.success(saveFile(bytes, filename, mimeType))\n                "shareFile" -> { shareFile(bytes, filename, mimeType); result.success(null) }\n                "copyImage" -> { copyImage(bytes, filename); result.success(null) }\n                "openFile" -> { openFile(bytes, filename, mimeType); result.success(null) }\n                else -> result.notImplemented()\n            }\n        } catch (error: Throwable) {\n            result.error("artifact_action_failed", error.message ?: "File action failed", null)\n        }\n    }\n\n    private fun safeFilename(value: String) = value.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(180).ifBlank { "sentiq-file" }\n    private fun writeShared(bytes: ByteArray, filename: String): File = File(File(cacheDir, "sentiq-shared").apply { mkdirs() }, filename).apply { writeBytes(bytes) }\n    private fun uriFor(file: File) = FileProvider.getUriForFile(this, "$packageName.files", file)\n\n    private fun saveFile(bytes: ByteArray, filename: String, mimeType: String): String {\n        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {\n            val values = ContentValues().apply {\n                put(MediaStore.Downloads.DISPLAY_NAME, filename)\n                put(MediaStore.Downloads.MIME_TYPE, mimeType)\n                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SentIQ Chat")\n                put(MediaStore.Downloads.IS_PENDING, 1)\n            }\n            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Could not create download")\n            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("Could not write download")\n            values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0); contentResolver.update(uri, values, null, null)\n            return uri.toString()\n        }\n        val directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: error("Downloads directory unavailable")\n        return File(directory, filename).apply { writeBytes(bytes) }.absolutePath\n    }\n\n    private fun shareFile(bytes: ByteArray, filename: String, mimeType: String) {\n        val uri = uriFor(writeShared(bytes, filename))\n        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {\n            type = mimeType; putExtra(Intent.EXTRA_STREAM, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)\n        }, "Share with"))\n    }\n\n    private fun copyImage(bytes: ByteArray, filename: String) {\n        val uri = uriFor(writeShared(bytes, filename))\n        val clipboard = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager\n        clipboard.setPrimaryClip(ClipData.newUri(contentResolver, "SentIQ image", uri))\n    }\n\n    private fun openFile(bytes: ByteArray, filename: String, mimeType: String) {\n        val uri = uriFor(writeShared(bytes, filename))\n        val intent = Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, mimeType); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }\n        if (intent.resolveActivity(packageManager) == null) error("No compatible Android application is installed")\n        startActivity(intent)\n    }\n}\n', encoding="utf-8")
PY

grep -q 'applicationId = "com.sentiqlabs.sentiqchat"' android/app/build.gradle.kts
grep -q 'android:host="login-callback"' android/app/src/main/AndroidManifest.xml
grep -q 'android:host="reset-callback"' android/app/src/main/AndroidManifest.xml
grep -q 'android:windowSoftInputMode="adjustResize"' android/app/src/main/AndroidManifest.xml
grep -q 'android.permission.CAMERA' android/app/src/main/AndroidManifest.xml
grep -q 'sentiq_file_paths' android/app/src/main/AndroidManifest.xml
grep -q 'com.sentiqlabs.sentiqchat/artifacts' android/app/src/main/kotlin/com/sentiqlabs/sentiq_chat/MainActivity.kt

printf 'Android scaffold ready: com.sentiqlabs.sentiqchat, API 28+, auth deep links enabled\n'
