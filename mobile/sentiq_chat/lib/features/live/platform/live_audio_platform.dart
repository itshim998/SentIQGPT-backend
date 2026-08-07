import 'package:flutter/services.dart';
import 'package:sentiq_chat/features/live/domain/live_models.dart';

abstract interface class LiveAudioGateway {
  Stream<LiveAudioEvent> get events;
  Future<bool> hasMicrophonePermission();
  Future<bool> requestMicrophonePermission();
  Future<void> startCapture({required int sampleRate});
  Future<void> stopCapture();
  Future<void> playPcm(Uint8List bytes, {required int sampleRate});
  Future<void> clearPlayback();
  Future<void> stopAudio();
  Future<List<LiveAudioRoute>> routes();
  Future<bool> selectRoute(int routeId);
}

class LiveAudioPlatform implements LiveAudioGateway {
  const LiveAudioPlatform({
    MethodChannel? methodChannel,
    EventChannel? eventChannel,
  }) : _methodChannel =
           methodChannel ??
           const MethodChannel('com.sentiqlabs.sentiqchat/live_audio'),
       _eventChannel =
           eventChannel ??
           const EventChannel('com.sentiqlabs.sentiqchat/live_audio_events');

  final MethodChannel _methodChannel;
  final EventChannel _eventChannel;

  @override
  Stream<LiveAudioEvent> get events {
    return _eventChannel.receiveBroadcastStream().map((Object? raw) {
      final Map<String, Object?> data = raw is Map
          ? raw.map(
              (Object? key, Object? value) => MapEntry(key.toString(), value),
            )
          : const <String, Object?>{};
      final Uint8List? bytes = switch (data['bytes']) {
        final Uint8List value => value,
        final List<int> value => Uint8List.fromList(value),
        _ => null,
      };
      final Map<String, Object?>? route = data['route'] is Map
          ? (data['route'] as Map).map(
              (Object? key, Object? value) => MapEntry(key.toString(), value),
            )
          : null;
      return LiveAudioEvent(
        type: data['type']?.toString() ?? 'unknown',
        bytes: bytes,
        level: data['level'] is num ? (data['level'] as num).toDouble() : null,
        route: route == null ? null : LiveAudioRoute.fromJson(route),
        message: data['message']?.toString(),
      );
    });
  }

  @override
  Future<bool> hasMicrophonePermission() async {
    return await _methodChannel.invokeMethod<bool>('hasMicrophonePermission') ??
        false;
  }

  @override
  Future<bool> requestMicrophonePermission() async {
    return await _methodChannel.invokeMethod<bool>(
          'requestMicrophonePermission',
        ) ??
        false;
  }

  @override
  Future<void> startCapture({required int sampleRate}) {
    return _methodChannel.invokeMethod<void>('startCapture', <String, Object?>{
      'sampleRate': sampleRate,
    });
  }

  @override
  Future<void> stopCapture() {
    return _methodChannel.invokeMethod<void>('stopCapture');
  }

  @override
  Future<void> playPcm(Uint8List bytes, {required int sampleRate}) {
    return _methodChannel.invokeMethod<void>('playPcm', <String, Object?>{
      'bytes': bytes,
      'sampleRate': sampleRate,
    });
  }

  @override
  Future<void> clearPlayback() {
    return _methodChannel.invokeMethod<void>('clearPlayback');
  }

  @override
  Future<void> stopAudio() {
    return _methodChannel.invokeMethod<void>('stopAudio');
  }

  @override
  Future<List<LiveAudioRoute>> routes() async {
    final List<Object?> raw =
        await _methodChannel.invokeListMethod<Object?>('audioRoutes') ??
        const <Object?>[];
    return raw
        .whereType<Map>()
        .map((Map item) {
          return LiveAudioRoute.fromJson(
            item.map(
              (Object? key, Object? value) => MapEntry(key.toString(), value),
            ),
          );
        })
        .toList(growable: false);
  }

  @override
  Future<bool> selectRoute(int routeId) async {
    return await _methodChannel.invokeMethod<bool>(
          'selectAudioRoute',
          <String, Object?>{'routeId': routeId},
        ) ??
        false;
  }
}
