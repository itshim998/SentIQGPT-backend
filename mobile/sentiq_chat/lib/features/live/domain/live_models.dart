import 'dart:typed_data';

enum LiveConnectionState {
  idle,
  requestingPermission,
  connecting,
  waitingForSetup,
  active,
  reconnecting,
  suspended,
  ending,
  ended,
  failed,
}

enum LiveTranscriptRole { user, assistant }

class LiveStatus {
  const LiveStatus({
    this.enabled = false,
    this.available = false,
    this.reason = 'not_available',
    this.remainingSecondsToday = 0,
    this.maxSessionSeconds = 0,
    this.activeSession = false,
  });

  factory LiveStatus.fromJson(Map<String, Object?> json) {
    return LiveStatus(
      enabled: json['enabled'] == true,
      available: json['available'] == true,
      reason: json['reason']?.toString() ?? 'not_available',
      remainingSecondsToday: _integer(
        json['remainingSecondsToday'] ?? json['remaining_seconds_today'],
      ),
      maxSessionSeconds: _integer(
        json['maxSessionSeconds'] ?? json['max_session_seconds'],
      ),
      activeSession:
          json['activeSession'] != null || json['active_session'] != null,
    );
  }

  final bool enabled;
  final bool available;
  final String reason;
  final int remainingSecondsToday;
  final int maxSessionSeconds;
  final bool activeSession;
}

class LiveInitialTurn {
  const LiveInitialTurn({required this.role, required this.text});

  factory LiveInitialTurn.fromJson(Map<String, Object?> json) {
    final Object? partsRaw = json['parts'];
    final StringBuffer text = StringBuffer();
    if (partsRaw is List) {
      for (final Object? part in partsRaw) {
        if (part is Map && part['text'] != null) {
          if (text.isNotEmpty) text.write('\n');
          text.write(part['text']);
        }
      }
    }
    return LiveInitialTurn(
      role: json['role']?.toString() == 'model' ? 'model' : 'user',
      text: text.toString().trim(),
    );
  }

  final String role;
  final String text;
}

class LiveSessionToken {
  const LiveSessionToken({
    required this.sessionId,
    required this.conversationId,
    required this.ephemeralToken,
    required this.webSocketUrl,
    required this.expiresAt,
    required this.newSessionExpiresAt,
    required this.sessionMaxSeconds,
    required this.inputSampleRate,
    required this.outputSampleRate,
    required this.model,
    this.initialHistory = const <LiveInitialTurn>[],
  });

  factory LiveSessionToken.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> audio = _map(json['audio']);
    final Map<String, Object?> setup = _map(json['setup']);
    final Object? historyRaw =
        json['initialHistory'] ?? json['initial_history'];
    final List<LiveInitialTurn> history = historyRaw is List
        ? historyRaw
              .whereType<Map>()
              .map((Map item) {
                return LiveInitialTurn.fromJson(
                  item.map(
                    (Object? key, Object? value) =>
                        MapEntry(key.toString(), value),
                  ),
                );
              })
              .where((LiveInitialTurn item) => item.text.isNotEmpty)
              .toList()
        : const <LiveInitialTurn>[];
    final int maximum = _integer(
      json['sessionMaxSeconds'] ??
          json['remaining_seconds'] ??
          json['session_max_seconds'],
    );
    final DateTime now = DateTime.now();
    return LiveSessionToken(
      sessionId: (json['sessionId'] ?? json['session_id'] ?? '').toString(),
      conversationId: (json['conversationId'] ?? json['conversation_id'] ?? '')
          .toString(),
      ephemeralToken: (json['ephemeralToken'] ?? json['token'] ?? '')
          .toString(),
      webSocketUrl: (json['webSocketUrl'] ?? json['web_socket_url'] ?? '')
          .toString(),
      expiresAt:
          _dateTime(json['expiresAt'] ?? json['expires_at']) ??
          now.add(Duration(seconds: maximum)),
      newSessionExpiresAt:
          _dateTime(
            json['newSessionExpiresAt'] ?? json['new_session_expires_at'],
          ) ??
          now.add(const Duration(seconds: 60)),
      sessionMaxSeconds: maximum,
      inputSampleRate: _sampleRate(audio['inputSampleRate'], 16000),
      outputSampleRate: _sampleRate(audio['outputSampleRate'], 24000),
      model: setup['model']?.toString() ?? 'models/gemini-live',
      initialHistory: history,
    );
  }

  final String sessionId;
  final String conversationId;
  final String ephemeralToken;
  final String webSocketUrl;
  final DateTime expiresAt;
  final DateTime newSessionExpiresAt;
  final int sessionMaxSeconds;
  final int inputSampleRate;
  final int outputSampleRate;
  final String model;
  final List<LiveInitialTurn> initialHistory;

  Uri get socketUri {
    final Uri base = Uri.parse(webSocketUrl);
    return base.replace(
      queryParameters: <String, String>{
        ...base.queryParameters,
        'access_token': ephemeralToken,
      },
    );
  }
}

class LiveTranscriptTurn {
  const LiveTranscriptTurn({
    required this.role,
    required this.text,
    this.finalized = true,
  });

  final LiveTranscriptRole role;
  final String text;
  final bool finalized;

  LiveTranscriptTurn copyWith({String? text, bool? finalized}) {
    return LiveTranscriptTurn(
      role: role,
      text: text ?? this.text,
      finalized: finalized ?? this.finalized,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'role': role == LiveTranscriptRole.user ? 'user' : 'assistant',
    'text': text,
  };
}

class LiveAudioRoute {
  const LiveAudioRoute({
    required this.id,
    required this.label,
    required this.type,
    this.selected = false,
  });

  factory LiveAudioRoute.fromJson(Map<String, Object?> json) {
    return LiveAudioRoute(
      id: _integer(json['id']),
      label: json['label']?.toString() ?? 'Audio device',
      type: json['type']?.toString() ?? 'unknown',
      selected: json['selected'] == true,
    );
  }

  final int id;
  final String label;
  final String type;
  final bool selected;
}

class LiveAudioEvent {
  const LiveAudioEvent({
    required this.type,
    this.bytes,
    this.level,
    this.route,
    this.message,
  });

  final String type;
  final Uint8List? bytes;
  final double? level;
  final LiveAudioRoute? route;
  final String? message;
}

class LiveState {
  const LiveState({
    this.status = const LiveStatus(),
    this.connection = LiveConnectionState.idle,
    this.session,
    this.transcript = const <LiveTranscriptTurn>[],
    this.remainingSeconds = 0,
    this.audioLevel = 0,
    this.routes = const <LiveAudioRoute>[],
    this.selectedRouteId,
    this.microphoneDenied = false,
    this.message,
  });

  final LiveStatus status;
  final LiveConnectionState connection;
  final LiveSessionToken? session;
  final List<LiveTranscriptTurn> transcript;
  final int remainingSeconds;
  final double audioLevel;
  final List<LiveAudioRoute> routes;
  final int? selectedRouteId;
  final bool microphoneDenied;
  final String? message;

  bool get active =>
      connection == LiveConnectionState.waitingForSetup ||
      connection == LiveConnectionState.active ||
      connection == LiveConnectionState.reconnecting ||
      connection == LiveConnectionState.suspended;

  LiveState copyWith({
    LiveStatus? status,
    LiveConnectionState? connection,
    LiveSessionToken? session,
    bool clearSession = false,
    List<LiveTranscriptTurn>? transcript,
    int? remainingSeconds,
    double? audioLevel,
    List<LiveAudioRoute>? routes,
    int? selectedRouteId,
    bool? microphoneDenied,
    String? message,
    bool clearMessage = false,
  }) {
    return LiveState(
      status: status ?? this.status,
      connection: connection ?? this.connection,
      session: clearSession ? null : session ?? this.session,
      transcript: transcript ?? this.transcript,
      remainingSeconds: remainingSeconds ?? this.remainingSeconds,
      audioLevel: audioLevel ?? this.audioLevel,
      routes: routes ?? this.routes,
      selectedRouteId: selectedRouteId ?? this.selectedRouteId,
      microphoneDenied: microphoneDenied ?? this.microphoneDenied,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}

int _integer(Object? value) => value is num ? value.toInt() : 0;

int _sampleRate(Object? value, int fallback) {
  final int parsed = _integer(value);
  return (parsed > 0 ? parsed : fallback).clamp(8000, 48000).toInt();
}

DateTime? _dateTime(Object? value) {
  final String text = value?.toString() ?? '';
  return text.isEmpty ? null : DateTime.tryParse(text)?.toLocal();
}
