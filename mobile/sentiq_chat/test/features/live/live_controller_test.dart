import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/live/application/live_controller.dart';
import 'package:sentiq_chat/features/live/data/gemini_live_transport.dart';
import 'package:sentiq_chat/features/live/data/live_repository.dart';
import 'package:sentiq_chat/features/live/domain/live_models.dart';
import 'package:sentiq_chat/features/live/platform/live_audio_platform.dart';

void main() {
  test('denied microphone permission fails without creating a token', () async {
    final _LiveRepoFake repo = _LiveRepoFake();
    final _AudioFake audio = _AudioFake()..permission = false;
    final _TransportFake transport = _TransportFake();
    final LiveController controller = LiveController(
      repository: repo,
      audio: audio,
      transport: transport,
    );

    expect(await controller.start('conversation-1'), isFalse);
    expect(controller.state.microphoneDenied, isTrue);
    expect(repo.createCount, 0);
    controller.dispose();
    await audio.close();
  });

  test(
    'setup, audio interruption, lifecycle and transcript commit are idempotent',
    () async {
      final _LiveRepoFake repo = _LiveRepoFake();
      final _AudioFake audio = _AudioFake();
      final _TransportFake transport = _TransportFake();
      final LiveController controller = LiveController(
        repository: repo,
        audio: audio,
        transport: transport,
      );

      await controller.initialize();
      expect(await controller.start('conversation-1'), isTrue);
      transport.emit(const <String, Object?>{
        'setupComplete': <String, Object?>{},
      });
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.connection, LiveConnectionState.active);
      expect(repo.startedCount, 1);

      transport.emit(<String, Object?>{
        'serverContent': <String, Object?>{
          'inputTranscription': <String, Object?>{'text': 'Hello'},
          'outputTranscription': <String, Object?>{'text': 'Hi there'},
          'turnComplete': true,
        },
      });
      await Future<void>.delayed(Duration.zero);
      audio.emit(const LiveAudioEvent(type: 'interruptionBegan'));
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.connection, LiveConnectionState.suspended);
      audio.emit(const LiveAudioEvent(type: 'interruptionEnded'));
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.connection, LiveConnectionState.active);

      await controller.handleLifecycle(AppLifecycleState.paused);
      expect(controller.state.connection, LiveConnectionState.suspended);
      await controller.handleLifecycle(AppLifecycleState.resumed);
      expect(controller.state.connection, LiveConnectionState.active);

      await controller.end();
      await controller.end();
      expect(repo.commitCount, 1);
      expect(repo.endCount, 0);
      controller.dispose();
      await audio.close();
    },
  );

  test(
    'expired reconnect window rotates to a fresh constrained token',
    () async {
      final _LiveRepoFake repo = _LiveRepoFake(expiredReconnectWindow: true);
      final _AudioFake audio = _AudioFake();
      final _TransportFake transport = _TransportFake();
      final LiveController controller = LiveController(
        repository: repo,
        audio: audio,
        transport: transport,
      );
      await controller.initialize();
      await controller.start('conversation-1');
      transport.emit(const <String, Object?>{
        'setupComplete': <String, Object?>{},
      });
      await Future<void>.delayed(Duration.zero);

      transport.emit(const <String, Object?>{'socketClosed': true});
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(repo.createCount, 2);
      expect(controller.state.connection, LiveConnectionState.waitingForSetup);
      controller.dispose();
      await audio.close();
    },
  );
}

class _LiveRepoFake implements LiveGateway {
  _LiveRepoFake({this.expiredReconnectWindow = false});

  final bool expiredReconnectWindow;
  int createCount = 0;
  int startedCount = 0;
  int commitCount = 0;
  int endCount = 0;

  @override
  Future<LiveStatus> status() async => const LiveStatus(
    enabled: true,
    available: true,
    remainingSecondsToday: 1200,
    maxSessionSeconds: 600,
  );

  @override
  Future<LiveSessionToken> createSession(String conversationId) async {
    createCount += 1;
    final DateTime now = DateTime.now();
    return LiveSessionToken(
      sessionId: 'session-$createCount',
      conversationId: conversationId,
      ephemeralToken: 'token-$createCount',
      webSocketUrl: 'wss://example.test/live',
      expiresAt: now.add(const Duration(minutes: 10)),
      newSessionExpiresAt: expiredReconnectWindow
          ? now.subtract(const Duration(seconds: 1))
          : now.add(const Duration(minutes: 1)),
      sessionMaxSeconds: 600,
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      model: 'models/live',
    );
  }

  @override
  Future<void> markStarted(String sessionId) async => startedCount += 1;

  @override
  Future<Map<String, Object?>> commit({
    required String sessionId,
    required List<LiveTranscriptTurn> transcript,
    String? summary,
  }) async {
    commitCount += 1;
    return const <String, Object?>{'committed': true};
  }

  @override
  Future<Map<String, Object?>> end({
    required String sessionId,
    required String reason,
  }) async {
    endCount += 1;
    return const <String, Object?>{'ended': true};
  }
}

class _AudioFake implements LiveAudioGateway {
  final StreamController<LiveAudioEvent> _events =
      StreamController<LiveAudioEvent>.broadcast();
  bool permission = true;
  int starts = 0;
  int stops = 0;

  @override
  Stream<LiveAudioEvent> get events => _events.stream;
  void emit(LiveAudioEvent event) => _events.add(event);
  Future<void> close() => _events.close();

  @override
  Future<bool> hasMicrophonePermission() async => permission;
  @override
  Future<bool> requestMicrophonePermission() async => permission;
  @override
  Future<void> startCapture({required int sampleRate}) async => starts += 1;
  @override
  Future<void> stopCapture() async => stops += 1;
  @override
  Future<void> playPcm(Uint8List bytes, {required int sampleRate}) async {}
  @override
  Future<void> clearPlayback() async {}
  @override
  Future<void> stopAudio() async {}
  @override
  Future<List<LiveAudioRoute>> routes() async => const <LiveAudioRoute>[];
  @override
  Future<bool> selectRoute(int routeId) async => true;
}

class _TransportFake implements LiveTransportGateway {
  final StreamController<Map<String, Object?>> _messages =
      StreamController<Map<String, Object?>>.broadcast();
  int connectCount = 0;

  @override
  Stream<Map<String, Object?>> get messages => _messages.stream;
  void emit(Map<String, Object?> message) => _messages.add(message);

  @override
  Future<void> connect(LiveSessionToken token) async => connectCount += 1;
  @override
  void sendSetup(LiveSessionToken token) {}
  @override
  void sendInitialHistory(List<LiveInitialTurn> history) {}
  @override
  void sendAudio(Uint8List bytes, {required int sampleRate}) {}
  @override
  void signalAudioStreamEnd() {}
  @override
  Future<void> close() async {}
  @override
  Future<void> dispose() => _messages.close();
}
