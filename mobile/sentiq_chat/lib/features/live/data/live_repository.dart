import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/live/domain/live_models.dart';

abstract interface class LiveGateway {
  Future<LiveStatus> status();
  Future<LiveSessionToken> createSession(String conversationId);
  Future<void> markStarted(String sessionId);
  Future<Map<String, Object?>> commit({
    required String sessionId,
    required List<LiveTranscriptTurn> transcript,
    String? summary,
  });
  Future<Map<String, Object?>> end({
    required String sessionId,
    required String reason,
  });
}

class LiveRepository implements LiveGateway {
  const LiveRepository(this._client);

  final SentIQApiClient _client;

  @override
  Future<LiveStatus> status() async {
    return LiveStatus.fromJson(await _client.getJson(ApiEndpoints.liveStatus));
  }

  @override
  Future<LiveSessionToken> createSession(String conversationId) async {
    return LiveSessionToken.fromJson(
      await _client.postJson(
        ApiEndpoints.liveSessionToken,
        body: <String, Object?>{'conversationId': conversationId},
      ),
    );
  }

  @override
  Future<void> markStarted(String sessionId) async {
    await _client.postJson(
      ApiEndpoints.liveSessionStarted(sessionId),
      body: const <String, Object?>{},
    );
  }

  @override
  Future<Map<String, Object?>> commit({
    required String sessionId,
    required List<LiveTranscriptTurn> transcript,
    String? summary,
  }) {
    return _client.postJson(
      ApiEndpoints.liveSessionCommit(sessionId),
      body: <String, Object?>{
        'transcript': transcript
            .where((LiveTranscriptTurn turn) => turn.text.trim().isNotEmpty)
            .map((LiveTranscriptTurn turn) => turn.toJson())
            .toList(growable: false),
        if (summary != null && summary.trim().isNotEmpty)
          'summary': summary.trim(),
      },
    );
  }

  @override
  Future<Map<String, Object?>> end({
    required String sessionId,
    required String reason,
  }) {
    return _client.postJson(
      ApiEndpoints.liveSessionEnd(sessionId),
      body: <String, Object?>{'reason': reason},
    );
  }
}
