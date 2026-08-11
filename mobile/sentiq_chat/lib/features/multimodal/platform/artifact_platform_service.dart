import 'package:flutter/services.dart';

class ArtifactPlatformService {
  const ArtifactPlatformService({MethodChannel? channel})
    : _channel =
          channel ?? const MethodChannel('com.sentiqlabs.sentiqchat/artifacts');

  final MethodChannel _channel;

  Future<String?> saveFile({
    required Uint8List bytes,
    required String filename,
    required String mimeType,
  }) {
    return _channel.invokeMethod<String>('saveFile', <String, Object?>{
      'bytes': bytes,
      'filename': filename,
      'mimeType': mimeType,
    });
  }

  Future<void> shareFile({
    required Uint8List bytes,
    required String filename,
    required String mimeType,
  }) {
    return _channel.invokeMethod<void>('shareFile', <String, Object?>{
      'bytes': bytes,
      'filename': filename,
      'mimeType': mimeType,
    });
  }

  Future<void> copyImage({
    required Uint8List bytes,
    required String filename,
    required String mimeType,
  }) {
    return _channel.invokeMethod<void>('copyImage', <String, Object?>{
      'bytes': bytes,
      'filename': filename,
      'mimeType': mimeType,
    });
  }

  Future<void> openFile({
    required Uint8List bytes,
    required String filename,
    required String mimeType,
  }) {
    return _channel.invokeMethod<void>('openFile', <String, Object?>{
      'bytes': bytes,
      'filename': filename,
      'mimeType': mimeType,
    });
  }
}
