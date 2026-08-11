package com.sentiqlabs.sentiq_chat

import android.Manifest
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.sqrt

class MainActivity : FlutterActivity(), EventChannel.StreamHandler {
    private val artifactChannelName = "com.sentiqlabs.sentiqchat/artifacts"
    private val liveAudioChannelName = "com.sentiqlabs.sentiqchat/live_audio"
    private val liveAudioEventsName = "com.sentiqlabs.sentiqchat/live_audio_events"
    private val permissionRequestCode = 7312
    private val mainHandler = Handler(Looper.getMainLooper())

    private var eventSink: EventChannel.EventSink? = null
    private var pendingPermissionResult: MethodChannel.Result? = null
    private var audioRecord: AudioRecord? = null
    private var captureThread: Thread? = null
    @Volatile private var capturing = false
    private var audioTrack: AudioTrack? = null
    private var audioTrackSampleRate = 0
    private lateinit var audioManager: AudioManager
    private var audioFocusRequest: AudioFocusRequest? = null

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
            emit(mapOf("type" to "routeChanged"))
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
            emit(mapOf("type" to "routeChanged"))
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                stopCaptureInternal()
                emit(mapOf("type" to "interruptionBegan"))
            }
            AudioManager.AUDIOFOCUS_GAIN -> emit(mapOf("type" to "interruptionEnded"))
        }
    }

    override fun onResume() {
        super.onResume()
        preferHighestRefreshRate()
    }

    private fun preferHighestRefreshRate() {
        val activeDisplay = window.decorView.display ?: return
        val currentMode = activeDisplay.mode
        val highestRefreshRate = activeDisplay.supportedModes
            .asSequence()
            .filter {
                it.physicalWidth == currentMode.physicalWidth &&
                    it.physicalHeight == currentMode.physicalHeight
            }
            .maxOfOrNull { it.refreshRate }
            ?: currentMode.refreshRate
        val attributes = window.attributes
        if (abs(attributes.preferredRefreshRate - highestRefreshRate) < 0.1f) return
        attributes.preferredRefreshRate = highestRefreshRate
        window.attributes = attributes
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, artifactChannelName)
            .setMethodCallHandler { call, result -> handleArtifactCall(call, result) }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, liveAudioChannelName)
            .setMethodCallHandler { call, result -> handleLiveAudioCall(call, result) }
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, liveAudioEventsName)
            .setStreamHandler(this)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        stopAudioInternal()
        audioManager.unregisterAudioDeviceCallback(deviceCallback)
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        eventSink = events
        emit(mapOf("type" to "routeChanged"))
    }

    override fun onCancel(arguments: Any?) {
        eventSink = null
    }

    private fun emit(event: Map<String, Any?>) {
        mainHandler.post { eventSink?.success(event) }
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

    private fun handleLiveAudioCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "hasMicrophonePermission" -> result.success(hasMicrophonePermission())
                "requestMicrophonePermission" -> requestMicrophonePermission(result)
                "startCapture" -> {
                    startCapture(call.argument<Int>("sampleRate") ?: 16_000)
                    result.success(null)
                }
                "stopCapture" -> { stopCaptureInternal(); result.success(null) }
                "playPcm" -> {
                    val bytes = call.argument<ByteArray>("bytes") ?: ByteArray(0)
                    playPcm(bytes, call.argument<Int>("sampleRate") ?: 24_000)
                    result.success(null)
                }
                "clearPlayback" -> { clearPlayback(); result.success(null) }
                "stopAudio" -> { stopAudioInternal(); result.success(null) }
                "audioRoutes" -> result.success(audioRoutes())
                "selectAudioRoute" -> result.success(selectAudioRoute(call.argument<Int>("routeId") ?: -1))
                else -> result.notImplemented()
            }
        } catch (error: SecurityException) {
            result.error("microphone_permission_denied", "Microphone permission is required.", null)
        } catch (error: Throwable) {
            result.error("live_audio_failed", error.message ?: "Live audio failed", null)
        }
    }

    private fun hasMicrophonePermission(): Boolean = ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED

    private fun requestMicrophonePermission(result: MethodChannel.Result) {
        if (hasMicrophonePermission()) {
            result.success(true)
            return
        }
        pendingPermissionResult?.success(false)
        pendingPermissionResult = result
        val permissions = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        ActivityCompat.requestPermissions(this, permissions.toTypedArray(), permissionRequestCode)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != permissionRequestCode) return
        pendingPermissionResult?.success(hasMicrophonePermission())
        pendingPermissionResult = null
    }

    @Suppress("MissingPermission")
    private fun startCapture(sampleRate: Int) {
        if (!hasMicrophonePermission()) throw SecurityException("Microphone permission denied")
        if (capturing) return
        requestAudioFocus()
        val minimum = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) error("Microphone configuration is unavailable")
        val bufferSize = maxOf(minimum * 2, sampleRate / 5 * 2)
        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            error("Microphone could not be initialized")
        }
        audioRecord = record
        capturing = true
        record.startRecording()
        captureThread = thread(name = "SentIQLiveCapture", isDaemon = true) {
            val buffer = ByteArray(maxOf(2048, minimum))
            while (capturing) {
                val read = record.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                if (read <= 0) continue
                val bytes = buffer.copyOf(read)
                emit(
                    mapOf(
                        "type" to "pcm",
                        "bytes" to bytes,
                        "level" to pcmLevel(bytes),
                    ),
                )
            }
        }
    }

    private fun pcmLevel(bytes: ByteArray): Double {
        if (bytes.size < 2) return 0.0
        var sum = 0.0
        var samples = 0
        var index = 0
        while (index + 1 < bytes.size) {
            val sample = ((bytes[index + 1].toInt() shl 8) or (bytes[index].toInt() and 0xff)).toShort().toInt()
            val normalized = sample / 32768.0
            sum += normalized * normalized
            samples += 1
            index += 2
        }
        return if (samples == 0) 0.0 else sqrt(sum / samples).coerceIn(0.0, 1.0)
    }

    private fun stopCaptureInternal() {
        capturing = false
        try { audioRecord?.stop() } catch (_: Throwable) { }
        captureThread?.interrupt()
        captureThread = null
        audioRecord?.release()
        audioRecord = null
    }

    private fun playPcm(bytes: ByteArray, sampleRate: Int) {
        if (bytes.isEmpty()) return
        val track = ensureAudioTrack(sampleRate)
        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
        track.write(bytes, 0, bytes.size, AudioTrack.WRITE_NON_BLOCKING)
    }

    private fun ensureAudioTrack(sampleRate: Int): AudioTrack {
        val existing = audioTrack
        if (existing != null && audioTrackSampleRate == sampleRate) return existing
        existing?.release()
        val minimum = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) error("Speaker configuration is unavailable")
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(minimum * 4, sampleRate / 2))
            .build()
        audioTrack = track
        audioTrackSampleRate = sampleRate
        return track
    }

    private fun clearPlayback() {
        val track = audioTrack ?: return
        try {
            track.pause()
            track.flush()
            track.play()
        } catch (_: Throwable) { }
    }

    private fun stopAudioInternal() {
        stopCaptureInternal()
        try { audioTrack?.stop() } catch (_: Throwable) { }
        audioTrack?.flush()
        audioTrack?.release()
        audioTrack = null
        audioTrackSampleRate = 0
        abandonAudioFocus()
    }

    private fun requestAudioFocus() {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            audioFocusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let(audioManager::abandonAudioFocusRequest)
            audioFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(focusListener)
        }
        audioManager.mode = AudioManager.MODE_NORMAL
    }

    private fun audioRoutes(): List<Map<String, Any?>> {
        val selectedId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.communicationDevice?.id
        } else null
        return audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .filter { isCommunicationOutput(it) }
            .map { device ->
                mapOf(
                    "id" to device.id,
                    "label" to device.productName.toString().ifBlank { routeType(device.type) },
                    "type" to routeType(device.type),
                    "selected" to (selectedId == device.id || selectedId == null && legacyRouteSelected(device)),
                )
            }
    }

    private fun isCommunicationOutput(device: AudioDeviceInfo): Boolean = when (device.type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE -> true
        else -> false
    }

    @Suppress("DEPRECATION")
    private fun legacyRouteSelected(device: AudioDeviceInfo): Boolean = when (device.type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> audioManager.isSpeakerphoneOn
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> audioManager.isBluetoothScoOn
        else -> false
    }

    @Suppress("MissingPermission", "DEPRECATION")
    private fun selectAudioRoute(routeId: Int): Boolean {
        val device = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .firstOrNull { it.id == routeId && isCommunicationOutput(it) }
            ?: return false
        val changed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED &&
                (device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
            ) {
                false
            } else {
                audioManager.setCommunicationDevice(device)
            }
        } else {
            when (device.type) {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> {
                    audioManager.isBluetoothScoOn = false
                    audioManager.stopBluetoothSco()
                    audioManager.isSpeakerphoneOn = true
                    true
                }
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> {
                    audioManager.isSpeakerphoneOn = false
                    audioManager.startBluetoothSco()
                    audioManager.isBluetoothScoOn = true
                    true
                }
                else -> {
                    audioManager.isSpeakerphoneOn = false
                    true
                }
            }
        }
        if (changed) emit(mapOf("type" to "routeChanged", "route" to audioRoutes().firstOrNull { it["id"] == routeId }))
        return changed
    }

    private fun routeType(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE -> "usb"
        else -> "other"
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
