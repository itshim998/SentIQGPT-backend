enum ConversationSyncState {
  synced,
  localOnly,
  pendingRename,
  pendingDelete;

  static ConversationSyncState parse(Object? value) {
    return ConversationSyncState.values.firstWhere(
      (ConversationSyncState state) => state.name == value?.toString(),
      orElse: () => ConversationSyncState.synced,
    );
  }
}

class ConversationSummary {
  const ConversationSummary({
    required this.id,
    required this.ownerScope,
    required this.title,
    required this.createdAt,
    required this.updatedAt,
    required this.syncState,
    this.lastMessagePreview,
    this.firstUserMessage,
    this.messageCount = 0,
  });

  factory ConversationSummary.fromJson(
    Map<String, Object?> json, {
    required String ownerScope,
  }) {
    final String id =
        (json['id'] ?? json['conversation_id'] ?? json['conversationId'])
            ?.toString()
            .trim() ??
        '';
    final DateTime now = DateTime.now().toUtc();
    final DateTime createdAt =
        _date(json['created_at'] ?? json['createdAt']) ?? now;
    final String? firstUserMessage = _nullableText(
      json['first_user_message'] ?? json['firstUserMessage'],
    );
    return ConversationSummary(
      id: id,
      ownerScope: ownerScope,
      title: _text(json['title'], fallback: 'New chat'),
      createdAt: createdAt,
      // The backend's canonical chat-history ordering is based on
      // last_activity_at. Older mobile builds ignored it and substituted the
      // local clock, which made Android ordering diverge after a cold restore.
      updatedAt:
          _date(
            json['last_activity_at'] ??
                json['lastActivityAt'] ??
                json['updated_at'] ??
                json['updatedAt'],
          ) ??
          createdAt,
      syncState: ConversationSyncState.synced,
      firstUserMessage: firstUserMessage,
      messageCount: _integer(json['message_count'] ?? json['messageCount']) ?? 0,
      lastMessagePreview:
          _nullableText(json['last_message_preview'] ?? json['preview']) ??
          firstUserMessage,
    );
  }

  final String id;
  final String ownerScope;
  final String title;
  final DateTime createdAt;

  /// Canonical activity timestamp used for chat-history display ordering.
  /// For cloud rows this is the backend's `last_activity_at`.
  final DateTime updatedAt;
  final ConversationSyncState syncState;
  final String? lastMessagePreview;
  final String? firstUserMessage;
  final int messageCount;

  /// True only for titles that are safe for the automatic first-exchange
  /// title generator to replace. Explicit user-renamed titles are never
  /// treated as repair candidates.
  bool get needsGeneratedTitle {
    final String normalizedTitle = _comparable(title);
    if (normalizedTitle.isEmpty ||
        normalizedTitle == 'new chat' ||
        normalizedTitle == 'live conversation' ||
        normalizedTitle == 'untitled chat') {
      return true;
    }

    final String normalizedFirst = _comparable(
      firstUserMessage ?? lastMessagePreview ?? '',
    );
    if (normalizedFirst.isEmpty || normalizedTitle.length < 8) return false;

    if (normalizedFirst.startsWith(normalizedTitle)) return true;
    final int prefixLength = normalizedFirst.length < normalizedTitle.length
        ? normalizedFirst.length
        : normalizedTitle.length;
    return normalizedTitle.startsWith(
      normalizedFirst.substring(0, prefixLength),
    );
  }

  ConversationSummary copyWith({
    String? title,
    DateTime? updatedAt,
    ConversationSyncState? syncState,
    String? lastMessagePreview,
    String? firstUserMessage,
    int? messageCount,
  }) {
    return ConversationSummary(
      id: id,
      ownerScope: ownerScope,
      title: title ?? this.title,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      syncState: syncState ?? this.syncState,
      lastMessagePreview: lastMessagePreview ?? this.lastMessagePreview,
      firstUserMessage: firstUserMessage ?? this.firstUserMessage,
      messageCount: messageCount ?? this.messageCount,
    );
  }

  Map<String, Object?> toDatabase() => <String, Object?>{
    'id': id,
    'owner_scope': ownerScope,
    'title': title,
    'created_at': createdAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
    'sync_state': syncState.name,
    'last_message_preview': lastMessagePreview,
    'first_user_message': firstUserMessage,
    'message_count': messageCount,
  };

  static ConversationSummary fromDatabase(Map<String, Object?> row) {
    return ConversationSummary(
      id: row['id'].toString(),
      ownerScope: row['owner_scope'].toString(),
      title: _text(row['title'], fallback: 'New chat'),
      createdAt: _date(row['created_at']) ?? DateTime.now().toUtc(),
      updatedAt: _date(row['updated_at']) ?? DateTime.now().toUtc(),
      syncState: ConversationSyncState.parse(row['sync_state']),
      lastMessagePreview: _nullableText(row['last_message_preview']),
      firstUserMessage: _nullableText(row['first_user_message']),
      messageCount: _integer(row['message_count']) ?? 0,
    );
  }
}

String _text(Object? value, {required String fallback}) {
  final String text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

String? _nullableText(Object? value) {
  final String text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

DateTime? _date(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toUtc();
}

int? _integer(Object? value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

String _comparable(Object? value) {
  return value
      ?.toString()
      .toLowerCase()
      .replaceAll(RegExp('[^a-z0-9]+'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim() ??
      '';
}
