import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';

class CloudConversationSource {
  const CloudConversationSource(this._client);

  final SentIQApiClient _client;

  Future<List<ConversationSummary>> list(String ownerScope) async {
    final Map<String, Object?> payload =
        await _client.getJson(ApiEndpoints.conversations);
    final Object? raw = payload['conversations'] ?? payload['data'];
    if (raw is! List) return const <ConversationSummary>[];
    return raw
        .whereType<Map>()
        .map(
          (Map value) => ConversationSummary.fromJson(
            value.map(
              (Object? key, Object? nested) => MapEntry(key.toString(), nested),
            ),
            ownerScope: ownerScope,
          ),
        )
        .where((ConversationSummary item) => item.id.isNotEmpty)
        .toList();
  }

  Future<ConversationSummary> create(
    String ownerScope,
    String title, {
    String? preferredId,
  }) async {
    final Map<String, Object?> payload = await _client.postJson(
      ApiEndpoints.conversations,
      body: <String, Object?>{
        'title': title,
        if (preferredId != null) 'conversationId': preferredId,
      },
    );
    final Map<String, Object?> raw = _map(
      payload['conversation'] ?? payload['data'] ?? payload,
    );
    return ConversationSummary.fromJson(raw, ownerScope: ownerScope);
  }

  Future<ConversationSummary> rename(
    ConversationSummary conversation,
    String title,
  ) async {
    final Map<String, Object?> payload = await _client.patchJson(
      ApiEndpoints.conversationTitle(conversation.id),
      body: <String, Object?>{'title': title},
    );
    final Map<String, Object?> raw = _map(
      payload['conversation'] ?? payload['data'] ?? payload,
    );
    if (raw['id'] == null && raw['conversation_id'] == null) {
      return conversation.copyWith(
        title: title,
        updatedAt: DateTime.now().toUtc(),
        syncState: ConversationSyncState.synced,
      );
    }
    return ConversationSummary.fromJson(
      raw,
      ownerScope: conversation.ownerScope,
    );
  }

  Future<void> delete(String id) async {
    await _client.deleteJson(ApiEndpoints.conversation(id));
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}
