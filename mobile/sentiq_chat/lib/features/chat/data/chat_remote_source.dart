import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';

class ChatRemoteSource {
  const ChatRemoteSource(this._client);

  final SentIQApiClient _client;

  Future<List<ChatMessage>> loadMessages(String conversationId) async {
    final Map<String, Object?> payload = await _client.getJson(
      ApiEndpoints.conversationMessages(conversationId),
    );
    final Object? raw = payload['messages'] ?? payload['data'];
    if (raw is! List) return const <ChatMessage>[];
    return raw
        .whereType<Map>()
        .map(
          (Map value) => ChatMessage.fromJson(
            value.map(
              (Object? key, Object? nested) => MapEntry(key.toString(), nested),
            ),
            conversationId: conversationId,
          ),
        )
        .where((ChatMessage item) => item.id.isNotEmpty)
        .toList();
  }

  Future<SentIQSseConnection> stream(ChatTurnRequest request) {
    return _client.postSseCancellable(
      ApiEndpoints.chatStream,
      body: request.toJson(),
    );
  }

  Future<ChatAttachment> upload(ChatAttachment attachment) async {
    final Map<String, Object?> payload = await _client.postMultipart(
      ApiEndpoints.filesUpload,
      fields: const <String, String>{},
      files: <SentIQMultipartFile>[
        SentIQMultipartFile(
          field: 'file',
          filename: attachment.name,
          bytes: attachment.bytes,
          contentType: attachment.mimeType,
        ),
      ],
    );
    final Map<String, Object?> data = _map(
      payload['file'] ?? payload['data'] ?? payload,
    );
    return attachment.copyWith(
      extractedText:
          (data['extractedText'] ??
                  data['extracted_text'] ??
                  data['text'] ??
                  '')
              .toString(),
      analysisId: (data['analysis_id'] ?? data['analysisId'])?.toString(),
      sourceDocumentId: (data['source_document_id'] ?? data['document_id'])
          ?.toString(),
      uploading: false,
      failed: false,
    );
  }

  Future<Map<String, Object?>> askAboutSelection({
    required String conversationId,
    required String selectedText,
    required List<ChatMessage> recentMessages,
  }) {
    return _client.postJson(
      ApiEndpoints.chatSelection,
      body: <String, Object?>{
        'selected_text': selectedText,
        'conversationId': conversationId,
        'context': <String, Object?>{
          'recent_messages': recentMessages
              .where(
                (ChatMessage item) =>
                    item.role == ChatMessageRole.user ||
                    item.role == ChatMessageRole.assistant,
              )
              .map(
                (ChatMessage item) => <String, Object?>{
                  'role': item.role.name,
                  'content': item.content,
                },
              )
              .toList(),
        },
      },
    );
  }

  Future<Map<String, Object?>> sync({
    required String conversationId,
    required List<ChatMessage> messages,
  }) {
    return _client.postJson(
      ApiEndpoints.chatSync,
      body: <String, Object?>{
        'conversationId': conversationId,
        'messages': messages
            .where((ChatMessage item) => item.content.trim().isNotEmpty)
            .map((ChatMessage item) => item.toSyncJson())
            .toList(),
      },
    );
  }

  Future<ChatQuotaState> quota() async {
    try {
      final Map<String, Object?> payload = await _client.getJson(
        ApiEndpoints.billingMe,
      );
      return ChatQuotaState.fromJson(payload);
    } catch (_) {
      return const ChatQuotaState();
    }
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}
