// ignore_for_file: sort_constructors_first

import 'dart:convert';
import 'dart:typed_data';

enum ChatExecutionMode { fast, intuitive }

enum ChatMessageRole { user, assistant, system }

enum ChatMessageStatus {
  pending,
  streaming,
  complete,
  interrupted,
  failed,
  cancelled,
  syncing,
}

enum ChatToolKind { attachment, image, webSearch }

enum ChatProgressKind {
  thinking,
  route,
  toolSelected,
  toolStarted,
  toolResult,
  toolError,
  sources,
  fileAnalysis,
  deepResearch,
  memory,
  sync,
}

class ChatAttachment {
  const ChatAttachment({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.sizeBytes,
    required this.bytes,
    this.extractedText,
    this.analysisId,
    this.sourceDocumentId,
    this.uploading = false,
    this.failed = false,
    this.cancelled = false,
    this.progress = 0,
    this.statusMessage,
  });

  final String id;
  final String name;
  final String mimeType;
  final int sizeBytes;
  final Uint8List bytes;
  final String? extractedText;
  final String? analysisId;
  final String? sourceDocumentId;
  final bool uploading;
  final bool failed;
  final bool cancelled;
  final double progress;
  final String? statusMessage;

  bool get isImage =>
      mimeType == 'image/png' ||
      mimeType == 'image/jpeg' ||
      mimeType == 'image/webp';

  ChatAttachment copyWith({
    String? extractedText,
    String? analysisId,
    String? sourceDocumentId,
    bool? uploading,
    bool? failed,
    bool? cancelled,
    double? progress,
    String? statusMessage,
    bool clearStatusMessage = false,
  }) {
    return ChatAttachment(
      id: id,
      name: name,
      mimeType: mimeType,
      sizeBytes: sizeBytes,
      bytes: bytes,
      extractedText: extractedText ?? this.extractedText,
      analysisId: analysisId ?? this.analysisId,
      sourceDocumentId: sourceDocumentId ?? this.sourceDocumentId,
      uploading: uploading ?? this.uploading,
      failed: failed ?? this.failed,
      cancelled: cancelled ?? this.cancelled,
      progress: progress ?? this.progress,
      statusMessage: clearStatusMessage
          ? null
          : statusMessage ?? this.statusMessage,
    );
  }

  Map<String, Object?> toImagePayload() => <String, Object?>{
    'filename': name,
    'mime_type': mimeType,
    'base64': base64Encode(bytes),
    'size_bytes': sizeBytes,
  };

  Map<String, Object?> toFileReference() => <String, Object?>{
    'filename': name,
    'extractedText': extractedText ?? '',
    if (analysisId != null) 'analysis_id': analysisId,
    if (sourceDocumentId != null) 'source_document_id': sourceDocumentId,
    'size_bytes': sizeBytes,
    'mime_type': mimeType,
  };
}

class ChatCitation {
  const ChatCitation({
    required this.id,
    required this.label,
    this.url,
    this.title,
  });

  final String id;
  final String label;
  final String? url;
  final String? title;

  factory ChatCitation.fromJson(Map<String, Object?> json, int index) {
    return ChatCitation(
      id: (json['id'] ?? json['source_id'] ?? 'source-${index + 1}').toString(),
      label: (json['label'] ?? json['citation'] ?? '[${index + 1}]').toString(),
      url: json['url']?.toString(),
      title: (json['title'] ?? json['name'])?.toString(),
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'label': label,
    if (url != null) 'url': url,
    if (title != null) 'title': title,
  };
}

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.conversationId,
    required this.role,
    required this.content,
    required this.createdAt,
    required this.status,
    this.clientRequestId,
    this.executionMode,
    this.citations = const <ChatCitation>[],
    this.metadata = const <String, Object?>{},
    this.errorMessage,
    this.locallyCreated = false,
  });

  final String id;
  final String conversationId;
  final ChatMessageRole role;
  final String content;
  final DateTime createdAt;
  final ChatMessageStatus status;
  final String? clientRequestId;
  final ChatExecutionMode? executionMode;
  final List<ChatCitation> citations;
  final Map<String, Object?> metadata;
  final String? errorMessage;
  final bool locallyCreated;

  bool get canRetry =>
      role == ChatMessageRole.user &&
      (status == ChatMessageStatus.failed ||
          status == ChatMessageStatus.cancelled);

  bool get canContinue =>
      role == ChatMessageRole.assistant &&
      (status == ChatMessageStatus.interrupted ||
          status == ChatMessageStatus.cancelled) &&
      content.trim().isNotEmpty;

  ChatMessage copyWith({
    String? id,
    String? content,
    ChatMessageStatus? status,
    List<ChatCitation>? citations,
    Map<String, Object?>? metadata,
    String? errorMessage,
    bool clearError = false,
    bool? locallyCreated,
  }) {
    return ChatMessage(
      id: id ?? this.id,
      conversationId: conversationId,
      role: role,
      content: content ?? this.content,
      createdAt: createdAt,
      status: status ?? this.status,
      clientRequestId: clientRequestId,
      executionMode: executionMode,
      citations: citations ?? this.citations,
      metadata: metadata ?? this.metadata,
      errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
      locallyCreated: locallyCreated ?? this.locallyCreated,
    );
  }

  factory ChatMessage.fromJson(
    Map<String, Object?> json, {
    required String conversationId,
  }) {
    final Map<String, Object?> metadata = <String, Object?>{
      ..._stringMap(json['meta'] ?? json['metadata']),
      if (json['message_type'] != null) 'type': json['message_type'],
      if (json['image_url'] != null) 'image_url': json['image_url'],
      if (json['storage_path'] != null) 'storage_path': json['storage_path'],
      if (json['prompt'] != null) 'prompt': json['prompt'],
      if (json['provider'] != null) 'provider_used': json['provider'],
      if (json['file_size_bytes'] != null)
        'file_size_bytes': json['file_size_bytes'],
      if (json['file_url'] != null) 'file_url': json['file_url'],
      if (json['file_name'] != null) 'file_name': json['file_name'],
      if (json['file_format'] != null) 'format': json['file_format'],
      if (json['mime_type'] != null) 'mime_type': json['mime_type'],
      if (json['generated_file_id'] != null)
        'file_id': json['generated_file_id'],
      if (json['preview_json'] != null) 'preview': json['preview_json'],
    };
    final String roleValue =
        (json['role'] ?? json['message_role'] ?? 'assistant')
            .toString()
            .toLowerCase();
    final String statusValue =
        (json['status'] ?? metadata['status'] ?? 'complete')
            .toString()
            .toLowerCase();
    final Object? rawCitations = json['citations'] ?? metadata['citations'];
    final List<ChatCitation> citations = rawCitations is List
        ? rawCitations
              .whereType<Map>()
              .toList()
              .asMap()
              .entries
              .map(
                (MapEntry<int, Map> entry) => ChatCitation.fromJson(
                  entry.value.map(
                    (Object? key, Object? value) =>
                        MapEntry(key.toString(), value),
                  ),
                  entry.key,
                ),
              )
              .toList()
        : const <ChatCitation>[];
    return ChatMessage(
      id:
          (json['id'] ??
                  json['message_id'] ??
                  '$roleValue-${json['client_request_id'] ?? json['created_at'] ?? ''}')
              .toString(),
      conversationId:
          (json['conversation_id'] ?? json['conversationId'] ?? conversationId)
              .toString(),
      role: switch (roleValue) {
        'user' => ChatMessageRole.user,
        'system' => ChatMessageRole.system,
        _ => ChatMessageRole.assistant,
      },
      content: (json['content'] ?? json['text'] ?? json['message'] ?? '')
          .toString(),
      createdAt:
          DateTime.tryParse(
            (json['created_at'] ?? json['createdAt'] ?? '').toString(),
          )?.toUtc() ??
          DateTime.now().toUtc(),
      status: ChatMessageStatus.values.firstWhere(
        (ChatMessageStatus value) => value.name == statusValue,
        orElse: () => ChatMessageStatus.complete,
      ),
      clientRequestId: (json['client_request_id'] ?? json['clientRequestId'])
          ?.toString(),
      executionMode: _modeFrom(
        json['execution_mode'] ?? metadata['execution_mode'],
      ),
      citations: citations,
      metadata: metadata,
      errorMessage: (json['error'] ?? metadata['error'])?.toString(),
    );
  }

  factory ChatMessage.fromDatabase(Map<String, Object?> row) {
    final Map<String, Object?> metadata = _decodeMap(row['metadata_json']);
    final Object? rawCitations = _decodeObject(row['citations_json']);
    final List<ChatCitation> citations = rawCitations is List
        ? rawCitations
              .whereType<Map>()
              .toList()
              .asMap()
              .entries
              .map(
                (MapEntry<int, Map> entry) => ChatCitation.fromJson(
                  entry.value.map(
                    (Object? key, Object? value) =>
                        MapEntry(key.toString(), value),
                  ),
                  entry.key,
                ),
              )
              .toList()
        : const <ChatCitation>[];
    return ChatMessage(
      id: row['id'].toString(),
      conversationId: row['conversation_id'].toString(),
      role: ChatMessageRole.values.firstWhere(
        (ChatMessageRole value) => value.name == row['role'],
        orElse: () => ChatMessageRole.assistant,
      ),
      content: row['content']?.toString() ?? '',
      createdAt:
          DateTime.tryParse(row['created_at']?.toString() ?? '')?.toUtc() ??
          DateTime.now().toUtc(),
      status: ChatMessageStatus.values.firstWhere(
        (ChatMessageStatus value) => value.name == row['status'],
        orElse: () => ChatMessageStatus.complete,
      ),
      clientRequestId: row['client_request_id']?.toString(),
      executionMode: _modeFrom(row['execution_mode']),
      citations: citations,
      metadata: metadata,
      errorMessage: row['error_message']?.toString(),
      locallyCreated: (row['locally_created'] as num?)?.toInt() == 1,
    );
  }

  Map<String, Object?> toDatabase(String ownerScope) => <String, Object?>{
    'id': id,
    'conversation_id': conversationId,
    'owner_scope': ownerScope,
    'role': role.name,
    'content': content,
    'created_at': createdAt.toUtc().toIso8601String(),
    'status': status.name,
    'client_request_id': clientRequestId,
    'execution_mode': executionMode?.name,
    'citations_json': jsonEncode(
      citations.map((ChatCitation item) => item.toJson()).toList(),
    ),
    'metadata_json': jsonEncode(metadata),
    'error_message': errorMessage,
    'locally_created': locallyCreated ? 1 : 0,
  };

  Map<String, Object?> toSyncJson() => <String, Object?>{
    'id': id,
    'role': role.name,
    'content': content,
    'created_at': createdAt.toUtc().toIso8601String(),
    if (clientRequestId != null) 'client_request_id': clientRequestId,
    if (executionMode != null) 'execution_mode': executionMode!.name,
    if (metadata.isNotEmpty) 'meta': metadata,
  };
}

class ChatProgressEvent {
  const ChatProgressEvent({
    required this.kind,
    required this.label,
    required this.timestamp,
    this.detail,
    this.payload = const <String, Object?>{},
    this.terminal = false,
    this.error = false,
  });

  final ChatProgressKind kind;
  final String label;
  final DateTime timestamp;
  final String? detail;
  final Map<String, Object?> payload;
  final bool terminal;
  final bool error;
}

class ChatQuotaState {
  const ChatQuotaState({
    this.fastAvailable = true,
    this.intuitiveAvailable = true,
    this.fastRemaining,
    this.intuitiveRemaining,
    this.resetAt,
    this.message,
  });

  final bool fastAvailable;
  final bool intuitiveAvailable;
  final int? fastRemaining;
  final int? intuitiveRemaining;
  final DateTime? resetAt;
  final String? message;

  bool allows(ChatExecutionMode mode) => switch (mode) {
    ChatExecutionMode.fast => fastAvailable,
    ChatExecutionMode.intuitive => intuitiveAvailable,
  };

  factory ChatQuotaState.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> quota = _stringMap(
      json['text_quota'] ?? json['quota'] ?? json['usage'] ?? json,
    );
    final Map<String, Object?> fast = _stringMap(quota['fast']);
    final Map<String, Object?> intuitive = _stringMap(quota['intuitive']);
    int? readRemaining(Map<String, Object?> value, String prefix) {
      final Object? raw = value['remaining'] ?? quota['${prefix}_remaining'];
      return raw is num ? raw.toInt() : int.tryParse(raw?.toString() ?? '');
    }

    final int? fastRemaining = readRemaining(fast, 'fast');
    final int? intuitiveRemaining = readRemaining(intuitive, 'intuitive');
    return ChatQuotaState(
      fastAvailable:
          (fast['available'] ?? quota['fast_available'] ?? true) != false &&
          (fastRemaining == null || fastRemaining > 0),
      intuitiveAvailable:
          (intuitive['available'] ?? quota['intuitive_available'] ?? true) !=
              false &&
          (intuitiveRemaining == null || intuitiveRemaining > 0),
      fastRemaining: fastRemaining,
      intuitiveRemaining: intuitiveRemaining,
      resetAt: DateTime.tryParse(
        (quota['reset_at'] ?? quota['resetAt'] ?? '').toString(),
      )?.toUtc(),
      message: (quota['message'] ?? json['message'])?.toString(),
    );
  }
}

class ChatTurnRequest {
  const ChatTurnRequest({
    required this.conversationId,
    required this.clientRequestId,
    required this.message,
    required this.executionMode,
    required this.recentMessages,
    required this.attachments,
    required this.webSearchEnabled,
    this.trustedDisplayName,
  });

  final String conversationId;
  final String clientRequestId;
  final String message;
  final ChatExecutionMode executionMode;
  final List<ChatMessage> recentMessages;
  final List<ChatAttachment> attachments;
  final bool webSearchEnabled;
  final String? trustedDisplayName;

  Map<String, Object?> toJson() => <String, Object?>{
    'message': message,
    'conversationId': conversationId,
    'client_request_id': clientRequestId,
    'execution_mode': executionMode.name,
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
      'file_references': attachments
          .where((ChatAttachment item) => !item.isImage && !item.failed)
          .map((ChatAttachment item) => item.toFileReference())
          .toList(),
      'image_attachments': attachments
          .where((ChatAttachment item) => item.isImage && !item.failed)
          .map((ChatAttachment item) => item.toImagePayload())
          .toList(),
      if (webSearchEnabled) 'web_search_mode': 'basic',
      if (trustedDisplayName != null && trustedDisplayName!.trim().isNotEmpty)
        'trusted_profile': <String, Object?>{
          'display_name': trustedDisplayName!.trim(),
        },
    },
  };
}

ChatExecutionMode? _modeFrom(Object? value) {
  final String normalized = value?.toString().toLowerCase() ?? '';
  return switch (normalized) {
    'fast' => ChatExecutionMode.fast,
    'intuitive' => ChatExecutionMode.intuitive,
    _ => null,
  };
}

Map<String, Object?> _stringMap(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}

Object? _decodeObject(Object? value) {
  if (value == null) return null;
  try {
    return jsonDecode(value.toString());
  } on FormatException {
    return null;
  }
}

Map<String, Object?> _decodeMap(Object? value) {
  return _stringMap(_decodeObject(value));
}
