package com.sentiqlabs.sentiq_chat

import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    private val channelName = "com.sentiqlabs.sentiqchat/artifacts"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result -> handleArtifactCall(call, result) }
    }

    private fun handleArtifactCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            val bytes = call.argument<ByteArray>("bytes") ?: throw IllegalArgumentException("Missing file bytes")
            val filename = safeFilename(call.argument<String>("filename") ?: "sentiq-file")
            val mimeType = call.argument<String>("mimeType") ?: "application/octet-stream"
            when (call.method) {
                "saveFile" -> result.success(saveFile(bytes, filename, mimeType))
                "shareFile" -> { shareFile(bytes, filename, mimeType); result.success(null) }
                "copyImage" -> { copyImage(bytes, filename); result.success(null) }
                "openFile" -> { openFile(bytes, filename, mimeType); result.success(null) }
                else -> result.notImplemented()
            }
        } catch (error: Throwable) {
            result.error("artifact_action_failed", error.message ?: "File action failed", null)
        }
    }

    private fun safeFilename(value: String) = value.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(180).ifBlank { "sentiq-file" }
    private fun writeShared(bytes: ByteArray, filename: String): File = File(File(cacheDir, "sentiq-shared").apply { mkdirs() }, filename).apply { writeBytes(bytes) }
    private fun uriFor(file: File) = FileProvider.getUriForFile(this, "$packageName.files", file)

    private fun saveFile(bytes: ByteArray, filename: String, mimeType: String): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SentIQ Chat")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Could not create download")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("Could not write download")
            values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0); contentResolver.update(uri, values, null, null)
            return uri.toString()
        }
        val directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: error("Downloads directory unavailable")
        return File(directory, filename).apply { writeBytes(bytes) }.absolutePath
    }

    private fun shareFile(bytes: ByteArray, filename: String, mimeType: String) {
        val uri = uriFor(writeShared(bytes, filename))
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = mimeType; putExtra(Intent.EXTRA_STREAM, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }, "Share with"))
    }

    private fun copyImage(bytes: ByteArray, filename: String) {
        val uri = uriFor(writeShared(bytes, filename))
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(ClipData.newUri(contentResolver, "SentIQ image", uri))
    }

    private fun openFile(bytes: ByteArray, filename: String, mimeType: String) {
        val uri = uriFor(writeShared(bytes, filename))
        val intent = Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, mimeType); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        if (intent.resolveActivity(packageManager) == null) error("No compatible Android application is installed")
        startActivity(intent)
    }
}
