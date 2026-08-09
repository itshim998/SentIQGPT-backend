import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';

class CloudConversationSnapshot {
  const CloudConversationSnapshot({
    required this.items,
    this.aliases = const <String, String>{},
  });

  final List<ConversationSummary> items;
  final Map<String, String> aliases;
}

class CloudConversationSource {
  const CloudConversationSource(this._client);

  final SentIQApiClient _client;

  Future<CloudConversationSnapshot> snapshot(String ownerScope) async {
    final Map<String, Object?> payload = await _client.getJson(
      ApiEndpoints.conversations,
    );
    final Object? raw = payload['conversations'] ?? payload['data'];
    if (raw is! List) {
      throw const FormatException('Conversation history response is malformed');
    }

    final List<ConversationSummary> parsed = <ConversationSummary>[];
    for (final Object? rawConversation in raw) {
      if (rawConversation is! Map) {
        throw const FormatException(
          'Conversation history contains a malformed row',
        );
      }
      final ConversationSummary conversation = ConversationSummary.fromJson(
        rawConversation.map(
          (Object? key, Object? nested) => MapEntry(key.toString(), nested),
        ),
        ownerScope: ownerScope,
      );
      if (conversation.id.isEmpty) {
        throw const FormatException(
          'Conversation history contains a row without an identifier',
        );
      }
      parsed.add(conversation);
    }
    final List<ConversationSummary> items = parsed
        .take(50)
        .toList(growable: false);

    final Map<String, String> aliases = <String, String>{};
    final Object? rawMerged = payload['merged'];
    if (rawMerged is List) {
      for (final Object? rawNotice in rawMerged) {
        if (rawNotice is! Map) continue;
        final String from = rawNotice['from']?.toString().trim() ?? '';
        final String to = rawNotice['to']?.toString().trim() ?? '';
        if (from.isNotEmpty && to.isNotEmpty && from != to) {
          aliases[from] = to;
        }
      }
    }
    return CloudConversationSnapshot(items: items, aliases: aliases);
  }

  Future<List<ConversationSummary>> list(String ownerScope) async {
    return (await snapshot(ownerScope)).items;
  }

  Future<ConversationSummary> create(
    String ownerScope,
    String title, {
    String? preferredId,
  }) async {
    final Map<String, Object?> body = <String, Object?>{'title': title};
    if (preferredId != null) body['conversationId'] = preferredId;
    final Map<String, Object?> payload = await _client.postJson(
      ApiEndpoints.conversations,
      body: body,
    );
    final Map<String, Object?> raw = _map(
      payload['conversation'] ?? payload['data'] ?? payload,
    );
    final ConversationSummary created = ConversationSummary.fromJson(
      raw,
      ownerScope: ownerScope,
    );
    if (created.id.isEmpty) {
      throw const FormatException(
        'Created conversation response is missing its identifier',
      );
    }
    return created;
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

  /// Repairs generic/first-message fallback titles through the exact same
  /// first-exchange title endpoint used by the web client. The backend owns
  /// provider selection and persists the resulting title, so Android and web
  /// cannot diverge on title-generation policy.
  Future<ConversationSummary> repairGeneratedTitle(
    String ownerScope,
    ConversationSummary conversation,
  ) async {
    if (!conversation.needsGeneratedTitle || conversation.messageCount < 2) {
      return conversation;
    }

    final Map<String, Object?> payload = await _client.getJson(
      ApiEndpoints.conversationMessages(conversation.id),
    );
    final Object? rawMessages = payload['messages'] ?? payload['data'];
    if (rawMessages is! List) return conversation;

    String firstUserMessage = '';
    String firstAssistantReply = '';
    for (final Object? raw in rawMessages) {
      if (raw is! Map) continue;
      final Map<String, Object?> message = raw.map(
        (Object? key, Object? value) => MapEntry(key.toString(), value),
      );
      final String role = (message['role'] ?? message['message_role'] ?? '')
          .toString()
          .toLowerCase();
      final String content =
          (message['content'] ?? message['text'] ?? message['message'] ?? '')
              .toString()
              .trim();
      if (content.isEmpty) continue;
      if (firstUserMessage.isEmpty && role == 'user') {
        firstUserMessage = content;
        continue;
      }
      if (firstUserMessage.isNotEmpty &&
          firstAssistantReply.isEmpty &&
          role == 'assistant') {
        firstAssistantReply = content;
        break;
      }
    }
    if (firstUserMessage.isEmpty || firstAssistantReply.isEmpty) {
      return conversation;
    }

    final Map<String, Object?> titlePayload = await _client.postJson(
      ApiEndpoints.chatTitle,
      body: <String, Object?>{
        'userMessage': firstUserMessage,
        'assistantReply': firstAssistantReply,
        'conversationId': conversation.id,
      },
    );
    final String title = titlePayload['title']?.toString().trim() ?? '';
    if (title.isEmpty) return conversation;

    return conversation.copyWith(
      title: title,
      firstUserMessage: firstUserMessage,
      lastMessagePreview: conversation.lastMessagePreview ?? firstUserMessage,
      syncState: ConversationSyncState.synced,
    );
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}
