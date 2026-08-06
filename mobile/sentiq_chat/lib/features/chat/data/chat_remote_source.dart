import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/multimodal/data/content_policy.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';

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
    final SentIQMultipartUpload upload = await startUpload(attachment);
    final Map<String, Object?> payload = await upload.response;
    return attachmentFromUpload(attachment, payload);
  }

  Future<SentIQMultipartUpload> startUpload(
    ChatAttachment attachment, {
    String? conversationId,
  }) {
    return _client.startMultipartUpload(
      ApiEndpoints.filesUpload,
      fields: <String, String>{'conversationId': ?conversationId},
      files: <SentIQMultipartFile>[
        SentIQMultipartFile(
          field: 'file',
          filename: attachment.name,
          bytes: attachment.bytes,
          contentType: attachment.mimeType,
        ),
      ],
    );
  }

  ChatAttachment attachmentFromUpload(
    ChatAttachment attachment,
    Map<String, Object?> payload,
  ) {
    final Map<String, Object?> data = _map(
      payload['file'] ?? payload['data'] ?? payload,
    );
    final String extracted =
        (data['extractedText'] ?? data['extracted_text'] ?? data['text'] ?? '')
            .toString();
    String? notice;
    if (AttachmentPolicy.looksLikeScannedPdf(extracted)) {
      notice =
          'This PDF appears to be scanned or image-based. No selectable text was found, so answers may be limited.';
    } else if (AttachmentPolicy.isLongPdf(
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      text: extracted,
    )) {
      notice =
          'This is a long PDF. SentIQ Chat will use the most relevant sections and may need additional questions for complete coverage.';
    }
    return attachment.copyWith(
      extractedText: extracted,
      analysisId: (data['analysis_id'] ?? data['analysisId'])?.toString(),
      sourceDocumentId: (data['source_document_id'] ?? data['document_id'])
          ?.toString(),
      uploading: false,
      failed: false,
      progress: 1,
      statusMessage: notice ?? 'Ready',
    );
  }

  Future<SentIQSseConnection> fileUpdates() {
    return _client.getSseCancellable(ApiEndpoints.filesUpdates);
  }

  Future<void> clearFileSession(String? analysisId) async {
    await _client.deleteJson(
      ApiEndpoints.filesSession,
      body: <String, Object?>{'analysis_id': ?analysisId},
    );
  }

  Future<ImageQuotaState> imageQuota() async {
    try {
      return ImageQuotaState.fromJson(
        await _client.getJson(ApiEndpoints.imagesQuota),
      );
    } catch (_) {
      return const ImageQuotaState();
    }
  }

  Future<Map<String, Object?>> generateImage({
    required String prompt,
    required String conversationId,
    required String clientRequestId,
    required ChatExecutionMode executionMode,
  }) {
    return _client.postJson(
      ApiEndpoints.imagesGenerate,
      body: <String, Object?>{
        'prompt': prompt,
        'conversationId': conversationId,
        'clientRequestId': clientRequestId,
        'executionMode': executionMode.name,
      },
    );
  }

  Future<void> deleteImage(String id) async {
    await _client.deleteJson(ApiEndpoints.image(id));
  }

  Future<Map<String, Object?>> artifactDownload(String id) {
    return _client.getJson(ApiEndpoints.generatedFileDownload(id));
  }

  Future<Map<String, Object?>> artifactPreview(String id) {
    return _client.getJson(ApiEndpoints.generatedFilePreview(id));
  }

  Future<Map<String, Object?>> updateArtifactHtml({
    required String id,
    required String html,
    int? version,
  }) {
    return _client.patchJson(
      ApiEndpoints.generatedFile(id),
      body: <String, Object?>{'html': html, 'version': ?version},
    );
  }

  Future<void> deleteArtifact(String id) async {
    await _client.deleteJson(ApiEndpoints.generatedFile(id));
  }

  Future<SentIQBinaryResponse> downloadRemote(
    String url, {
    int maximumBytes = RemoteContentPolicy.maximumArtifactBytes,
  }) {
    return _client.getBytes(
      RemoteContentPolicy.requireHttps(url),
      maximumBytes: maximumBytes,
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
