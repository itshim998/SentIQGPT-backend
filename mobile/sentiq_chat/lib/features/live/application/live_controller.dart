import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/features/live/data/gemini_live_transport.dart';
import 'package:sentiq_chat/features/live/data/live_repository.dart';
import 'package:sentiq_chat/features/live/domain/live_models.dart';
import 'package:sentiq_chat/features/live/platform/live_audio_platform.dart';

class LiveController extends StateNotifier<LiveState> {
  LiveController({
    required LiveGateway repository,
    required LiveAudioGateway audio,
    required LiveTransportGateway transport,
  }) : _repository = repository,
       _audio = audio,
       _transport = transport,
       super(const LiveState()) {
    _audioSubscription = _audio.events.listen(_handleAudioEvent);
    _transportSubscription = _transport.messages.listen(
      _handleTransportMessage,
      onError: (Object error, StackTrace stackTrace) {
        unawaited(_handleSocketClosed(error: error));
      },
    );
  }

  final LiveGateway _repository;
  final LiveAudioGateway _audio;
  final LiveTransportGateway _transport;
  StreamSubscription<LiveAudioEvent>? _audioSubscription;
  StreamSubscription<Map<String, Object?>>? _transportSubscription;
  Timer? _remainingTimer;
  Timer? _setupTimeout;
  String? _conversationId;
  int _sessionTranscriptStart = 0;
  int _reconnectAttempts = 0;
  bool _intentionalSocketClose = false;
  bool _lifecycleSuspended = false;
  bool _disposed = false;
  final Set<String> _startedSessionIds = <String>{};
  final Set<String> _committedSessionIds = <String>{};

  Future<void> initialize() async {
    await refreshStatus();
    await refreshRoutes();
  }

  Future<void> refreshStatus() async {
    try {
      final LiveStatus status = await _repository.status();
      if (!_disposed) {
        state = state.copyWith(status: status, clearMessage: true);
      }
    } catch (error) {
      if (!_disposed) state = state.copyWith(message: _message(error));
    }
  }

  Future<void> refreshRoutes() async {
    try {
      final List<LiveAudioRoute> routes = await _audio.routes();
      if (_disposed) return;
      int? selectedRouteId;
      for (final LiveAudioRoute route in routes) {
        if (route.selected) {
          selectedRouteId = route.id;
          break;
        }
      }
      state = state.copyWith(routes: routes, selectedRouteId: selectedRouteId);
    } catch (_) {
      // Route selection is best effort on devices that expose it.
    }
  }

  Future<bool> start(String conversationId) async {
    if (state.active ||
        state.connection == LiveConnectionState.connecting ||
        state.connection == LiveConnectionState.requestingPermission) {
      return false;
    }
    _conversationId = conversationId;
    state = state.copyWith(
      connection: LiveConnectionState.requestingPermission,
      microphoneDenied: false,
      transcript: const <LiveTranscriptTurn>[],
      clearMessage: true,
      clearSession: true,
    );
    try {
      final bool permitted =
          await _audio.hasMicrophonePermission() ||
          await _audio.requestMicrophonePermission();
      if (!permitted) {
        if (!_disposed) {
          state = state.copyWith(
            connection: LiveConnectionState.failed,
            microphoneDenied: true,
            message:
                'Microphone access is required for SentIQ Live. You can allow it from Android settings.',
          );
        }
        return false;
      }
      await refreshStatus();
      if (!state.status.available) {
        state = state.copyWith(
          connection: LiveConnectionState.failed,
          message: _statusMessage(state.status.reason),
        );
        return false;
      }
      _sessionTranscriptStart = 0;
      await _createAndConnect(conversationId);
      return true;
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(
          connection: LiveConnectionState.failed,
          message: _message(error),
        );
      }
      return false;
    }
  }

  Future<void> _createAndConnect(String conversationId) async {
    state = state.copyWith(
      connection: LiveConnectionState.connecting,
      clearMessage: true,
    );
    final LiveSessionToken session = await _repository.createSession(
      conversationId,
    );
    if (_disposed) return;
    state = state.copyWith(
      session: session,
      remainingSeconds: session.sessionMaxSeconds,
      connection: LiveConnectionState.waitingForSetup,
    );
    _intentionalSocketClose = false;
    await _transport.connect(session);
    _transport.sendSetup(session);
    _setupTimeout?.cancel();
    _setupTimeout = Timer(const Duration(seconds: 12), () {
      if (state.connection == LiveConnectionState.waitingForSetup) {
        unawaited(
          _failAndEnd(
            'Live connection did not finish starting.',
            'websocket_failed',
          ),
        );
      }
    });
  }

  Future<void> _handleSetupComplete() async {
    final LiveSessionToken? session = state.session;
    if (session == null || _disposed) return;
    _setupTimeout?.cancel();
    _transport.sendInitialHistory(session.initialHistory);
    try {
      if (!_lifecycleSuspended) {
        await _audio.startCapture(sampleRate: session.inputSampleRate);
      }
      if (_startedSessionIds.add(session.sessionId)) {
        await _repository.markStarted(session.sessionId);
      }
      _reconnectAttempts = 0;
      _startRemainingTimer();
      if (!_disposed) {
        state = state.copyWith(
          connection: _lifecycleSuspended
              ? LiveConnectionState.suspended
              : LiveConnectionState.active,
          clearMessage: true,
        );
      }
    } catch (error) {
      await _failAndEnd(_message(error), 'audio_start_failed');
    }
  }

  void _handleAudioEvent(LiveAudioEvent event) {
    if (_disposed) return;
    if (event.type == 'pcm') {
      final Uint8List? bytes = event.bytes;
      final LiveSessionToken? session = state.session;
      if (bytes != null &&
          session != null &&
          state.connection == LiveConnectionState.active) {
        _transport.sendAudio(bytes, sampleRate: session.inputSampleRate);
      }
      if (event.level != null) {
        state = state.copyWith(audioLevel: event.level!.clamp(0, 1).toDouble());
      }
    } else if (event.type == 'routeChanged') {
      unawaited(refreshRoutes());
    } else if (event.type == 'interruptionBegan') {
      state = state.copyWith(
        connection: LiveConnectionState.suspended,
        message:
            'Audio was interrupted. SentIQ Live will resume when possible.',
      );
    } else if (event.type == 'interruptionEnded' && !_lifecycleSuspended) {
      final LiveSessionToken? session = state.session;
      if (session != null) {
        unawaited(_audio.startCapture(sampleRate: session.inputSampleRate));
        state = state.copyWith(
          connection: LiveConnectionState.active,
          clearMessage: true,
        );
      }
    }
  }

  void _handleTransportMessage(Map<String, Object?> message) {
    if (_disposed) return;
    if (message['socketClosed'] == true) {
      unawaited(_handleSocketClosed());
      return;
    }
    if (message.containsKey('setupComplete') ||
        message.containsKey('setup_complete')) {
      unawaited(_handleSetupComplete());
      return;
    }
    final Map<String, Object?> server = _map(
      message['serverContent'] ?? message['server_content'],
    );
    if (server.isEmpty) {
      final Map<String, Object?> goAway = _map(
        message['goAway'] ?? message['go_away'],
      );
      if (goAway.isNotEmpty) {
        state = state.copyWith(message: 'Live is preparing to reconnect.');
      }
      return;
    }

    _readTranscription(
      LiveTranscriptRole.user,
      server['inputTranscription'] ?? server['input_transcription'],
    );
    _readTranscription(
      LiveTranscriptRole.assistant,
      server['outputTranscription'] ?? server['output_transcription'],
    );
    final Map<String, Object?> modelTurn = _map(
      server['modelTurn'] ?? server['model_turn'],
    );
    final Object? partsRaw = modelTurn['parts'];
    if (partsRaw is List) {
      for (final Object? rawPart in partsRaw) {
        final Map<String, Object?> part = _map(rawPart);
        final Map<String, Object?> inline = _map(
          part['inlineData'] ?? part['inline_data'],
        );
        final String data = inline['data']?.toString() ?? '';
        if (data.isNotEmpty) {
          try {
            final Uint8List bytes = base64Decode(data);
            final int sampleRate = state.session?.outputSampleRate ?? 24000;
            unawaited(_audio.playPcm(bytes, sampleRate: sampleRate));
          } on FormatException {
            // Ignore malformed audio frames while retaining transcript updates.
          }
        }
      }
    }
    if (server['interrupted'] == true) {
      unawaited(_audio.clearPlayback());
      _finalizePartialTranscript();
    }
    if (server['turnComplete'] == true || server['turn_complete'] == true) {
      _finalizePartialTranscript();
    }
  }

  void _readTranscription(LiveTranscriptRole role, Object? raw) {
    final Map<String, Object?> payload = _map(raw);
    final String text = payload['text']?.toString().trim() ?? '';
    if (text.isEmpty) return;
    final List<LiveTranscriptTurn> transcript = List<LiveTranscriptTurn>.of(
      state.transcript,
    );
    if (transcript.isNotEmpty &&
        transcript.last.role == role &&
        !transcript.last.finalized) {
      transcript[transcript.length - 1] = transcript.last.copyWith(text: text);
    } else {
      transcript.add(
        LiveTranscriptTurn(role: role, text: text, finalized: false),
      );
    }
    state = state.copyWith(transcript: transcript);
  }

  void _finalizePartialTranscript() {
    if (state.transcript.isEmpty) return;
    final List<LiveTranscriptTurn> transcript = state.transcript
        .map(
          (LiveTranscriptTurn turn) =>
              turn.finalized ? turn : turn.copyWith(finalized: true),
        )
        .toList(growable: false);
    state = state.copyWith(transcript: transcript);
  }

  Future<void> _handleSocketClosed({Object? error}) async {
    if (_intentionalSocketClose || _disposed || !state.active) return;
    final LiveSessionToken? session = state.session;
    if (session == null) return;
    await _audio.stopCapture();
    await _audio.clearPlayback();
    state = state.copyWith(
      connection: LiveConnectionState.reconnecting,
      message: 'Live connection was interrupted. Reconnecting…',
    );
    if (_reconnectAttempts < 2 &&
        DateTime.now().isBefore(
          session.newSessionExpiresAt.subtract(const Duration(seconds: 3)),
        )) {
      _reconnectAttempts += 1;
      await Future<void>.delayed(
        Duration(milliseconds: 500 * _reconnectAttempts),
      );
      try {
        await _transport.connect(session);
        _transport.sendSetup(session);
        state = state.copyWith(connection: LiveConnectionState.waitingForSetup);
        return;
      } catch (_) {
        // Rotate to a new constrained token below.
      }
    }
    try {
      await _commitCurrentSession();
      _sessionTranscriptStart = state.transcript.length;
      final String conversationId = _conversationId ?? session.conversationId;
      await _createAndConnect(conversationId);
    } catch (reconnectError) {
      await _failAndEnd(_message(reconnectError), 'websocket_failed');
    }
  }

  Future<void> selectRoute(int routeId) async {
    final bool changed = await _audio.selectRoute(routeId);
    if (changed) {
      state = state.copyWith(selectedRouteId: routeId);
      await refreshRoutes();
    }
  }

  Future<void> handleLifecycle(AppLifecycleState lifecycle) async {
    _lifecycleSuspended = lifecycle != AppLifecycleState.resumed;
    if (_lifecycleSuspended) {
      if (state.connection == LiveConnectionState.active) {
        await _audio.stopCapture();
        state = state.copyWith(connection: LiveConnectionState.suspended);
      }
      return;
    }
    final LiveSessionToken? session = state.session;
    if (session != null && state.connection == LiveConnectionState.suspended) {
      try {
        await _audio.startCapture(sampleRate: session.inputSampleRate);
        state = state.copyWith(
          connection: LiveConnectionState.active,
          clearMessage: true,
        );
      } catch (error) {
        state = state.copyWith(message: _message(error));
      }
    }
  }

  Future<void> end({String reason = 'client_end'}) async {
    final LiveSessionToken? session = state.session;
    if (session == null ||
        state.connection == LiveConnectionState.ending ||
        state.connection == LiveConnectionState.ended) {
      return;
    }
    state = state.copyWith(connection: LiveConnectionState.ending);
    _remainingTimer?.cancel();
    _setupTimeout?.cancel();
    _transport.signalAudioStreamEnd();
    await _audio.stopAudio();
    _intentionalSocketClose = true;
    await _transport.close();
    try {
      await _commitCurrentSession();
    } catch (_) {
      await _repository.end(sessionId: session.sessionId, reason: reason);
    }
    await refreshStatus();
    if (!_disposed) {
      state = state.copyWith(
        connection: LiveConnectionState.ended,
        remainingSeconds: 0,
        audioLevel: 0,
        clearSession: true,
      );
    }
  }

  Future<void> _commitCurrentSession() async {
    final LiveSessionToken? session = state.session;
    if (session == null || _committedSessionIds.contains(session.sessionId)) {
      return;
    }
    final List<LiveTranscriptTurn> transcript = state.transcript
        .skip(_sessionTranscriptStart)
        .where((LiveTranscriptTurn turn) => turn.text.trim().isNotEmpty)
        .map(
          (LiveTranscriptTurn turn) =>
              turn.finalized ? turn : turn.copyWith(finalized: true),
        )
        .toList(growable: false);
    if (transcript.isEmpty || !_startedSessionIds.contains(session.sessionId)) {
      await _repository.end(
        sessionId: session.sessionId,
        reason: transcript.isEmpty ? 'client_end' : 'error',
      );
      _committedSessionIds.add(session.sessionId);
      return;
    }
    await _repository.commit(
      sessionId: session.sessionId,
      transcript: transcript,
    );
    _committedSessionIds.add(session.sessionId);
  }

  void _startRemainingTimer() {
    _remainingTimer?.cancel();
    _remainingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_disposed || state.remainingSeconds <= 0) return;
      final int remaining = state.remainingSeconds - 1;
      state = state.copyWith(remainingSeconds: remaining);
      if (remaining <= 0) unawaited(end(reason: 'max_duration'));
    });
  }

  Future<void> _failAndEnd(String message, String reason) async {
    final LiveSessionToken? session = state.session;
    _remainingTimer?.cancel();
    _setupTimeout?.cancel();
    await _audio.stopAudio();
    _intentionalSocketClose = true;
    await _transport.close();
    if (session != null) {
      await _repository
          .end(sessionId: session.sessionId, reason: reason)
          .catchError((Object _) => <String, Object?>{});
    }
    if (!_disposed) {
      state = state.copyWith(
        connection: LiveConnectionState.failed,
        message: message,
        audioLevel: 0,
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _remainingTimer?.cancel();
    _setupTimeout?.cancel();
    unawaited(_audioSubscription?.cancel());
    unawaited(_transportSubscription?.cancel());
    unawaited(_audio.stopAudio());
    unawaited(_transport.dispose());
    super.dispose();
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return const <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}

String _message(Object error) {
  final String text = error.toString();
  return text.startsWith('Exception: ') ? text.substring(11) : text;
}

String _statusMessage(String reason) {
  return switch (reason) {
    'sign_in_required' => 'Sign in to use SentIQ Live.',
    'not_available_on_plan' =>
      'SentIQ Live is not available on your current plan.',
    'daily_limit_reached' => 'Your SentIQ Live time is used up for today.',
    'active_session_limit' => 'Another SentIQ Live session is already active.',
    'busy' => 'SentIQ Live is busy. Try again shortly.',
    _ => 'SentIQ Live is not available right now.',
  };
}
