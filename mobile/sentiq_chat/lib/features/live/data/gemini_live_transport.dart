import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:sentiq_chat/features/live/domain/live_models.dart';
import 'package:web_socket_channel/status.dart' as status;
import 'package:web_socket_channel/web_socket_channel.dart';

abstract interface class LiveTransportGateway {
  Stream<Map<String, Object?>> get messages;
  Future<void> connect(LiveSessionToken token);
  void sendSetup(LiveSessionToken token);
  void sendInitialHistory(List<LiveInitialTurn> history);
  void sendAudio(Uint8List bytes, {required int sampleRate});
  void signalAudioStreamEnd();
  Future<void> close();
  Future<void> dispose();
}

class GeminiLiveTransport implements LiveTransportGateway {
  GeminiLiveTransport();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  final StreamController<Map<String, Object?>> _messages =
      StreamController<Map<String, Object?>>.broadcast();

  @override
  Stream<Map<String, Object?>> get messages => _messages.stream;

  @override
  Future<void> connect(LiveSessionToken token) async {
    await close();
    final WebSocketChannel channel = WebSocketChannel.connect(token.socketUri);
    _channel = channel;
    await channel.ready;
    _subscription = channel.stream.listen(
      (dynamic raw) {
        try {
          final Object? decoded = jsonDecode(raw.toString());
          if (decoded is Map && !_messages.isClosed) {
            _messages.add(
              decoded.map(
                (Object? key, Object? value) => MapEntry(key.toString(), value),
              ),
            );
          }
        } catch (error, stackTrace) {
          if (!_messages.isClosed) _messages.addError(error, stackTrace);
        }
      },
      onError: (Object error, StackTrace stackTrace) {
        if (!_messages.isClosed) _messages.addError(error, stackTrace);
      },
      onDone: () {
        if (!_messages.isClosed) {
          _messages.add(const <String, Object?>{'socketClosed': true});
        }
      },
      cancelOnError: false,
    );
  }

  @override
  void sendSetup(LiveSessionToken token) {
    _send(<String, Object?>{
      'setup': <String, Object?>{
        'model': token.model,
        'generationConfig': <String, Object?>{
          'responseModalities': <String>['AUDIO'],
          'speechConfig': <String, Object?>{
            'voiceConfig': <String, Object?>{
              'prebuiltVoiceConfig': <String, Object?>{'voiceName': 'Aoede'},
            },
          },
        },
        'inputAudioTranscription': const <String, Object?>{},
        'outputAudioTranscription': const <String, Object?>{},
      },
    });
  }

  @override
  void sendInitialHistory(List<LiveInitialTurn> history) {
    if (history.isEmpty) return;
    _send(<String, Object?>{
      'clientContent': <String, Object?>{
        'turns': history
            .map(
              (LiveInitialTurn turn) => <String, Object?>{
                'role': turn.role,
                'parts': <Map<String, Object?>>[
                  <String, Object?>{'text': turn.text},
                ],
              },
            )
            .toList(growable: false),
        'turnComplete': true,
      },
    });
  }

  @override
  void sendAudio(Uint8List bytes, {required int sampleRate}) {
    _send(<String, Object?>{
      'realtimeInput': <String, Object?>{
        'audio': <String, Object?>{
          'mimeType': 'audio/pcm;rate=$sampleRate',
          'data': base64Encode(bytes),
        },
      },
    });
  }

  @override
  void signalAudioStreamEnd() {
    _send(const <String, Object?>{
      'realtimeInput': <String, Object?>{'audioStreamEnd': true},
    });
  }

  void _send(Map<String, Object?> payload) {
    final WebSocketChannel? channel = _channel;
    if (channel == null) return;
    channel.sink.add(jsonEncode(payload));
  }

  @override
  Future<void> close() async {
    await _subscription?.cancel();
    _subscription = null;
    await _channel?.sink.close(status.goingAway);
    _channel = null;
  }

  @override
  Future<void> dispose() async {
    await close();
    await _messages.close();
  }
}
